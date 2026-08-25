/// <reference types="vite/client" />

// Texture imports resolve to URLs at build time.
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
