"""peer.py without GitHub: the message format, the HTTP client's ETag/304/401 handling (mocked opener),
and the poller against an in-memory repository."""

from __future__ import annotations

import io
import json
import urllib.error
from email.message import Message

import pytest

from hermes_tern_plugin.backend.gateway import peer


# --- message format ---

def header(**kw):
    h = {"v": 1, "id": "b-1-aa", "from": "b", "to": "a", "kind": "ask", "reply_to": None}
    h.update(kw)
    return h


def test_encode_parse_round_trip_strips_the_banner():
    body = peer.encode(header(), "Diskte ne kadar yer var?\nikinci satır")
    assert body.startswith("<!-- hermes-mesh {") and "> **b → a** · ask · `b-1-aa`" in body
    h, text = peer.parse(body)
    assert h["kind"] == "ask" and h["from"] == "b" and text == "Diskte ne kadar yer var?\nikinci satır"


def test_a_value_cannot_close_the_html_comment():
    body = peer.encode(header(note="--> sonra"), "x")
    assert body.count("-->") == 1
    assert peer.parse(body)[0]["note"] == "--> sonra"


@pytest.mark.parametrize("body", [
    None, "düz yorum", "<!-- hermes-mesh {bozuk -->",
    peer.encode(header(v=2), "x"), peer.encode(header(kind="sil"), "x"), peer.encode(header(**{"from": "B C"}), "x"),
    peer.encode(header(to="x/y"), "x"), peer.encode(header(status="belki"), "x"), peer.encode(header(id=""), "x"),
])
def test_invalid_messages_are_ignored(body):
    assert peer.parse(body) is None


def test_pair_titles_are_order_independent():
    assert peer.pair_title("b", "a") == peer.pair_title("a", "b") == "mesh: a ↔ b"


def test_config_is_created_with_host_name_and_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(peer.socket, "gethostname", lambda: "DESKTOP-B0CSNKI")
    cfg = peer.load_config(tmp_path)
    assert (cfg.name, cfg.repo, cfg.owner, cfg.ask_assignee) == ("desktop-b0csnki", "Emirfs/hermes-mesh", "emirfs", "kodcu")
    saved = json.loads((tmp_path / "hermes-tern" / "peer.json").read_text(encoding="utf-8"))
    assert saved == {"name": "desktop-b0csnki", "repo": "Emirfs/hermes-mesh"}
    peer.write_json(tmp_path / "hermes-tern" / "peer.json", {"name": "is-pc", "repo": "Emirfs/hermes-mesh",
                                                             "ask_assignee": "mimar"})
    assert peer.load_config(tmp_path).ask_assignee == "mimar"


# --- HTTP client ---

class FakeResp:
    def __init__(self, status, data, headers=None):
        self.status, self._raw = status, json.dumps(data).encode()
        self.headers = Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, headers=None):
    msg = Message()
    for k, v in (headers or {}).items():
        msg[k] = v
    return urllib.error.HTTPError("https://api.github.com/x", code, "err", msg, io.BytesIO(b'{"message": "no"}'))


def test_conditional_get_sends_the_etag_and_maps_304():
    seen = []

    def opener(req, timeout):
        seen.append(dict(req.header_items()))
        if req.get_header("If-none-match") == '"e1"':
            raise http_error(304, {"ETag": '"e1"'})
        return FakeResp(200, [{"id": 1}], {"ETag": '"e1"'})

    gh = peer.GitHub(token=lambda refresh=False: "tok", opener=opener)
    first = gh.request("GET", "/repos/o/r/issues/comments", params={"since": "2026-01-01T00:00:00Z"})
    assert first.status == 200 and first.data == [{"id": 1}] and first.header("etag") == '"e1"'
    second = gh.request("GET", "/repos/o/r/issues/comments", etag=first.header("ETag"))
    assert second.status == 304 and second.data is None
    assert seen[0]["Authorization"] == "Bearer tok" and "If-none-match" not in seen[0]


def test_401_refreshes_the_token_once():
    tokens = []

    def token(refresh=False):
        tokens.append(refresh)
        return "new" if refresh else "old"

    def opener(req, timeout):
        if req.get_header("Authorization") == "Bearer old":
            raise http_error(401)
        return FakeResp(201, {"number": 7})

    assert peer.GitHub(token=token, opener=opener).request("POST", "/x", body={}).data == {"number": 7}
    assert tokens == [False, True]


def test_other_errors_raise_mesh_error():
    def opener(req, timeout):
        raise http_error(404)

    with pytest.raises(peer.MeshError, match="HTTP 404 no"):
        peer.GitHub(token=lambda refresh=False: "t", opener=opener).request("GET", "/x")


def test_next_link():
    resp = peer.Response(200, [], {"Link": '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'})
    assert peer.next_link(resp) == "https://api.github.com/x?page=2"
    assert peer.next_link(peer.Response(200, [])) is None


# --- poller against an in-memory repository ---

class FakeRepo:
    """The slice of the GitHub REST API the mesh uses, with ETags on the repo-wide comment list."""

    def __init__(self, owner="emirfs"):
        self.owner, self.issues, self.comments, self.calls = owner, [], [], []
        self.clock = 0

    def stamp(self):
        self.clock += 1
        return f"2099-01-01T00:{self.clock // 60:02d}:{self.clock % 60:02d}Z"

    def add_comment(self, issue, body, login=None):
        at = self.stamp()
        c = {"id": 1000 + len(self.comments), "body": body, "user": {"login": login or "Emirfs"},
             "issue_url": f"https://api.github.com/repos/Emirfs/hermes-mesh/issues/{issue}",
             "created_at": at, "updated_at": at, "html_url": f"https://github.com/c/{len(self.comments)}"}
        self.comments.append(c)
        return c

    def etag(self, items):
        return '"%d"' % hash(json.dumps(items, sort_keys=True))

    def request(self, method, path, *, params=None, body=None, etag=None):
        self.calls.append((method, path, dict(params or {}), etag))
        if method == "GET" and path.endswith("/issues"):
            return peer.Response(200, list(self.issues))
        if method == "POST" and path.endswith("/issues"):
            issue = {"number": len(self.issues) + 1, "title": body["title"], "labels": body["labels"]}
            self.issues.append(issue)
            return peer.Response(201, issue)
        if method == "POST" and path.endswith("/comments"):
            number = int(path.split("/")[-2])
            return peer.Response(201, self.add_comment(number, body["body"]))
        if method == "GET" and path.endswith("/comments"):
            since = (params or {}).get("since") or ""
            items = [c for c in self.comments if c["updated_at"] >= since]
            if "/issues/comments" not in path:
                number = int(path.split("/")[-2])
                items = [c for c in items if c["issue_url"].endswith(f"/{number}")]
            tag = self.etag(items)
            if etag == tag:
                return peer.Response(304, None, {"ETag": tag})
            return peer.Response(200, items, {"ETag": tag})
        raise AssertionError((method, path))


@pytest.fixture()
def repo():
    return FakeRepo()


def make_poller(tmp_path, repo, name="a", **kw):
    home = tmp_path / name
    home.mkdir(exist_ok=True)
    cfg = peer.PeerConfig(name=name, repo="Emirfs/hermes-mesh")
    sink = kw.pop("sink", [])
    cards = kw.pop("cards", {})

    def create(title, body, assignee, created_by, key):
        tid = cards.setdefault(key, {"id": f"t_{len(cards) + 1}", "title": title, "body": body,
                                     "assignee": assignee, "created_by": created_by, "status": "ready"})["id"]
        return tid

    def outcome(task_id):
        card = next((c for c in cards.values() if c["id"] == task_id), None)
        return (card["status"], card.get("detail", "")) if card else None

    p = peer.Poller(home, cfg, repo, notify=lambda t: sink.append(t) or True, create=create, outcome=outcome,
                    clock=lambda: 0.0)
    return p, sink, cards


def messages(repo):
    return [peer.parse(c["body"]) for c in repo.comments]


def test_inbound_ask_becomes_one_card_acked_then_answered_when_done(tmp_path, repo):
    a, _, cards = make_poller(tmp_path, repo, "a")
    b, _, _ = make_poller(tmp_path, repo, "b")
    a.tick()  # seeds the cursor, posts presence
    hdr, number, _ = peer.post(repo, b.home, b.cfg, "a", "ask", "Disk durumu nedir?")
    assert repo.issues[-1]["title"] == "mesh: a ↔ b" and repo.issues[-1]["labels"] == ["hermes-mesh"]
    a.tick()
    (card,) = cards.values()
    assert card["assignee"] == "kodcu" and card["created_by"] == "peer:b" and "Disk durumu nedir?" in card["body"]
    assert f"`{hdr['id']}`" in card["body"]
    ack = [m for m in messages(repo) if m and m[0]["kind"] == "ack"]
    assert ack and ack[0][0]["reply_to"] == hdr["id"] and ack[0][0]["task_id"] == card["id"]
    a.tick()  # nothing new: no second card, no reply yet
    assert len(cards) == 1 and not [m for m in messages(repo) if m and m[0]["kind"] == "reply"]
    card["status"], card["detail"] = "done", "%42 dolu"
    a.tick()
    (reply,) = [m for m in messages(repo) if m and m[0]["kind"] == "reply"]
    assert reply[0]["reply_to"] == hdr["id"] and reply[0]["status"] == "done" and reply[1] == "%42 dolu"
    assert reply[0]["from"] == "a" and reply[0]["to"] == "b"
    state = json.loads((a.home / "hermes-tern" / peer.STATE_FILE).read_text(encoding="utf-8"))
    assert state["inbound"] == {} and "b" in state["peers"]


def test_a_blocked_card_is_reported_once(tmp_path, repo):
    a, _, cards = make_poller(tmp_path, repo, "a")
    b, _, _ = make_poller(tmp_path, repo, "b")
    a.tick()
    peer.post(repo, b.home, b.cfg, "a", "ask", "RF gönder")
    a.tick()
    (card,) = cards.values()
    card["status"], card["detail"] = "blocked", "onay bekliyor"
    a.tick()
    a.tick()
    blocked = [m for m in messages(repo) if m and m[0].get("status") == "blocked"]
    assert len(blocked) == 1 and "onay bekliyor" in blocked[0][1]


def test_only_the_owner_and_only_messages_to_us_count(tmp_path, repo):
    a, sink, cards = make_poller(tmp_path, repo, "a")
    a.tick()
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(kind="notify", id="b-2"), "yabancı"), login="mallory")
    repo.add_comment(9, peer.encode(header(kind="notify", id="b-3", to="c"), "başkasına"))
    repo.add_comment(9, peer.encode(header(kind="notify", id="b-4"), "merhaba a"))
    repo.add_comment(9, peer.encode(header(kind="ask", id="a-5", **{"from": "a", "to": "b"}), "kendi mesajım"))
    a.tick()
    assert sink == ["📨 Peer b: merhaba a"] and cards == {}


def test_the_comment_list_is_fetched_with_etag_and_304_costs_nothing(tmp_path, repo):
    a, sink, _ = make_poller(tmp_path, repo, "a")
    a.tick()
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(kind="notify", id="b-4"), "bir"))
    a.tick()
    a.tick()
    lists = [c for c in repo.calls if c[1].endswith("/issues/comments")]
    assert lists[-1][3] is not None  # sent If-None-Match
    assert sink == ["📨 Peer b: bir"]  # not re-delivered by the repeated fetch


def test_a_late_reply_to_a_timed_out_ask_reaches_the_kanban_topic(tmp_path, repo):
    a, sink, _ = make_poller(tmp_path, repo, "a")
    a.tick()
    pending = peer.pending_path(a.home, "a-1-ff")
    peer.write_json(pending, {"peer": "b"})
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(kind="reply", id="b-9", reply_to="a-1-ff", status="done"), "cevap"))
    repo.add_comment(9, peer.encode(header(kind="reply", id="b-10", reply_to="a-other", status="done"), "senkron"))
    a.tick()
    assert sink == ["📬 Peer b yanıtladı (done): cevap"] and not pending.exists()


def test_undelivered_topic_messages_wait_in_the_outbox(tmp_path, repo):
    up = {"ok": False}
    sink = []
    a, _, _ = make_poller(tmp_path, repo, "a")
    a.notify = lambda t: up["ok"] and (sink.append(t) or True)
    a.tick()
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(kind="notify", id="b-4"), "sonra"))
    a.tick()
    assert sink == []
    up["ok"] = True
    a.tick()
    assert sink == ["📨 Peer b: sonra"]


def test_wait_reply_returns_the_reply_and_the_ack(tmp_path, repo):
    a, _, _ = make_poller(tmp_path, repo, "a")
    b, _, cards = make_poller(tmp_path, repo, "b")
    b.tick()
    hdr, number, _ = peer.post(repo, a.home, a.cfg, "b", "ask", "saat kaç?")
    b.tick()
    next(iter(cards.values()))["status"] = "done"
    next(iter(cards.values()))["detail"] = "12:00"
    b.tick()
    got = peer.wait_reply(repo, a.cfg, number, hdr["id"], "b", 0, since="2026-01-01T00:00:00Z")
    assert got["answered"] and got["reply"] == "12:00" and got["ack"]["task_id"] == "t_1"


def test_wait_reply_times_out(tmp_path, repo):
    a, _, _ = make_poller(tmp_path, repo, "a")
    hdr, number, _ = peer.post(repo, a.home, a.cfg, "b", "ask", "?")
    ticks = iter([0.0, 0.0, 3.0, 6.0, 6.0, 9.0, 9.0])
    got = peer.wait_reply(repo, a.cfg, number, hdr["id"], "b", 5, sleep=lambda s: None, clock=lambda: next(ticks),
                          since="2026-01-01T00:00:00Z")
    assert got == {"answered": False, "ack": None}


def test_tools_validate_arguments(tmp_path, monkeypatch):
    monkeypatch.setattr(peer.socket, "gethostname", lambda: "pc-a")
    assert "peer must be" in peer.peer_send_tool({"peer": "Kötü İsim", "text": "x"})
    assert "own peer name" in peer.peer_send_tool({"peer": "pc-a", "text": "x"})
    assert "text is empty" in peer.peer_ask_tool({"peer": "pc-b", "text": "  "})


def test_a_failed_ask_is_retried_next_tick(tmp_path, repo):
    a, _, cards = make_poller(tmp_path, repo, "a")
    real = a.create
    calls = []

    def flaky(*args):
        calls.append(args)
        if len(calls) == 1:
            raise OSError("db locked")
        return real(*args)

    a.create = flaky
    a.tick()
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(id="b-7"), "tekrar dene"))
    a.tick()
    assert cards == {}
    a.tick()
    assert len(cards) == 1 and len(calls) == 2


def test_an_ask_that_keeps_failing_is_answered_failed(tmp_path, repo):
    a, _, cards = make_poller(tmp_path, repo, "a")

    def broken(*args):
        raise OSError("no board")

    a.create = broken
    a.tick()
    repo.issues.append({"number": 9, "title": "mesh: a ↔ b"})
    repo.add_comment(9, peer.encode(header(id="b-8"), "olmayacak"))
    for _ in range(6):
        a.tick()
    replies = [m for m in messages(repo) if m and m[0]["kind"] == "reply"]
    assert len(replies) == 1 and replies[0][0]["status"] == "failed" and replies[0][0]["reply_to"] == "b-8"
