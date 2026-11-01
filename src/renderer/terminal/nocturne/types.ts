// Minimal integration types for the MIT Nocturne sound/material modules.
export type TypewriterVoice = 'standard' | 'portable' | 'electric' | 'whisper'
export type TypewriterSettings = { sound: boolean; volume: number; voice: TypewriterVoice; variation: number }
export type Paper = { surface: { felt: number; age: number; mottle: number; crinkle: number; laid: number; linen: number } }
export type LightRig = {
  source: 'carriage' | 'desk-lamp' | 'moonlight'
  position: [number, number, number]; direction: [number, number, number]
  cosOuter: number; cosInner: number; exposure: number
  window: { x: number; y: number; width: number; height: number; columns: number; rows: number; softness: number; skew: number }
}
