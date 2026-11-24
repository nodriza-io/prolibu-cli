// Cobalt web components (co-*) are loaded at runtime from /ui/static/cobalt/ by index.html.
// This lets JSX use them; look up each component's attributes in the Cobalt docs.
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

type CobaltElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  [attribute: string]: unknown
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      [tag: `co-${string}`]: CobaltElementProps
    }
  }
}
