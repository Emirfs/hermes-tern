import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { splitProgram } from '../watch/spec.js'
import { parseJson } from '../wire/json.js'

import { must } from './fakes.js'

describe('split commands', () => {
  it('keeps the macOS/Linux env prefix and arguments identical', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(splitProgram({ HERMES_HOME: '/home/a b', HERMES_TERN_WATCH: '{"name":"one"}' }, ['/venv/python', '-I', '-c', 'boot', 'tern'], platform)).toEqual([
        'env', 'HERMES_HOME=/home/a b', 'HERMES_TERN_WATCH={"name":"one"}', '/venv/python', '-I', '-c', 'boot', 'tern'
      ])
    }
  })
  it('runs on Windows without env or shell interpolation and preserves quotes, JSON and non-ASCII text', () => {
    const env = { HERMES_HOME: 'C:\\Users\\a b\\hermes', HERMES_TERN_WATCH: '{"name":"zażółć\'s $x %HOME%", "goal":"a \\"quote\\""}' }
    const args = ['a "b" c', "x'y", '$HOME', '%PATH%', 'a&b', 'zażółć']
    const command = splitProgram(env, [process.execPath, '-e', 'console.log(JSON.stringify({home:process.env.HERMES_HOME,watch:process.env.HERMES_TERN_WATCH,args:process.argv.slice(1)}))', ...args], 'win32')
    expect(command[0]).toBe(process.execPath)
    expect(command).not.toContain('env')
    const result = spawnSync(must(command[0]), command.slice(1), { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(parseJson(result.stdout)).toEqual({ args, home: env.HERMES_HOME, watch: env.HERMES_TERN_WATCH })
  })
  it('preserves a failing program exit code so Tern keeps its last lines readable', () => {
    const command = splitProgram({}, [process.execPath, '-e', 'process.exit(7)'], 'win32')
    const result = spawnSync(must(command[0]), command.slice(1))
    expect(result.status).toBe(7)
  })
})
