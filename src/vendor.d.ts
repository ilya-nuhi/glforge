/// <reference types="vite/client" />

// The draco3dgltf builds are Emscripten module factories with no typings of
// their own. glTF-Transform only needs the module they resolve to, untouched.
declare module 'draco3dgltf/draco_encoder_gltf_nodejs.js' {
  const createEncoderModule: (overrides?: { wasmBinary?: ArrayBuffer }) => Promise<unknown>;
  export default createEncoderModule;
}

declare module 'draco3dgltf/draco_decoder_gltf_nodejs.js' {
  const createDecoderModule: (overrides?: { wasmBinary?: ArrayBuffer }) => Promise<unknown>;
  export default createDecoderModule;
}
