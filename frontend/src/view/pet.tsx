import { css } from '@stencil-hq/tern'

import type { PetView } from '../pet/store.js'

/** Stable image id: animation updates only this node, without rebuilding the transcript. */
export const PET_IMAGE_ID = 'dock.pet.frame'

/** Docked at the chat's right edge, above the composer; takes space rather than covering words. */
export function petNode(pet: PetView | undefined) {
  return pet ? (
    <row align="end" justify="end" key="pet" role="hermes.pet" title={`${pet.name} · ${pet.state}`}>
      <image alt={`${pet.name} · ${pet.state}`} blob={pet.blob} h={pet.height} key="frame" w={pet.width} />
    </row>
  ) : null
}

export const PET_STYLES = css`
  [data-role='hermes.pet'] {
    padding: 0 12px;
    margin: 0;
    pointer-events: none;
  }
  [data-role='hermes.pet'] .sf-image {
    margin: 0;
  }
`
