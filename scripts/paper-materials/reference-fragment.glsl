#version 300 es
// Typewriter Nocturne demo shader (MIT). See resources/licenses/Typewriter-Nocturne.txt.
// Adaptation: sheet-edge shading is handled per pane, not baked into repeating tiles.
precision highp float;
uniform vec2 uSize; uniform float uScale; uniform int uSource;
uniform vec3 uLightPos; uniform vec3 uLightDir; uniform vec2 uCone; uniform float uExposure;
uniform vec4 uWindow; uniform vec2 uPane; uniform vec3 uTint; uniform float uLamp;
uniform float uAmbient; uniform vec3 uAmbientTint; uniform float uBump; uniform float uGrain; uniform float uTime;
uniform float uAge; uniform float uSeed; uniform float uFold; uniform float uMottle; uniform float uCrinkle;
uniform float uLaid; uniform float uLinen;
out vec4 outColor;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
// Parchment relief: vellum veins (domain-warped), long fibres, fine tooth.
float relief(vec2 p) {
  vec2 w = vec2(fbm(p * 0.012 + uSeed), fbm(p * 0.012 + uSeed + 9.2));
  float veins = 1.0 - abs(fbm(p * 0.02 + w * 3.0) * 2.0 - 1.0);
  float r = 0.35 * pow(veins, 6.0) + 0.35 * noise(p * vec2(0.6, 0.18)) + 0.3 * noise(p * 1.9);
  // Laid paper: fine laid lines across, chain lines down the sheet.
  float laidLines = 0.5 + 0.5 * sin(p.y * 6.2831 / 4.2);
  float chain = exp(-pow((mod(p.x, 96.0) - 48.0) / 3.2, 2.0));
  r = mix(r, r * 0.6 + laidLines * 0.18 + chain * 0.35, uLaid);
  // Linen: a woven cross-hatch with slubs.
  float weave = 0.5 + 0.5 * sin(p.x * 6.2831 / 3.4) * sin(p.y * 6.2831 / 3.4);
  float slub = noise(p * vec2(0.07, 1.3));
  return mix(r, r * 0.3 + weave * 0.5 + slub * 0.35, uLinen);
}
float panes(float t, float e) { float f = fract(t); return smoothstep(0.0, e, f) * smoothstep(0.0, e, 1.0 - f); }
float gobo(vec2 p) {
  vec2 uv = (p - uWindow.xy) / uWindow.zw;
  float e = max(0.02, uPane.y / max(uWindow.z, uWindow.w));
  float aperture = smoothstep(0.5, 0.5 - e * 2.0, abs(uv.x)) * smoothstep(0.5, 0.5 - e * 2.0, abs(uv.y));
  float me = min(0.45, 0.04 + uPane.y / uPane.x);
  float bars = panes((p.x - uWindow.x) / uPane.x + 0.5, me) * panes((p.y - uWindow.y) / uPane.x + 0.5, me);
  return aperture * (0.3 + 0.7 * bars);
}
float irradiance(vec3 P, vec3 n) {
  if (uSource == 2) return max(0.0, dot(n, -uLightDir)) * gobo(P.xy);
  vec3 d = P - uLightPos; float d2 = max(1.0, dot(d, d)); vec3 r = d * inversesqrt(d2);
  float cone = smoothstep(uCone.x, uCone.y, dot(r, uLightDir));
  return cone * max(0.0, -dot(n, r)) / d2;
}
vec3 parchment(vec2 p) {
  vec2 uv = p / uSize;
  // Large tonal mottling of skin and age.
  float mottle = fbm(p * 0.006 + uSeed) * 0.65 + fbm(p * 0.022 + uSeed * 2.0) * 0.35;
  vec3 base = mix(vec3(1.0), mix(vec3(1.0, 0.985, 0.95), vec3(0.86, 0.74, 0.55), smoothstep(0.35, 0.8, mottle) * 0.85), uMottle);
  vec3 tone = vec3(1.0);
  // Darker, irregular edges.
  float edge = min(min(uv.x, 1.0 - uv.x) * uSize.x, uv.y * uSize.y);
  float ragged = edge + (fbm(p * 0.05 + 3.0) - 0.5) * 26.0;
  float burn = 1.0 - smoothstep(0.0, 46.0, ragged);
  tone *= mix(vec3(1.0), vec3(0.62, 0.45, 0.28), burn * 0.85);
  // Foxing: small rust spots with soft halos.
  vec2 cell = floor(p / 70.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      float h = hash12(c + uSeed);
      if (h > 0.16) continue;
      vec2 centre = (c + vec2(hash12(c + 1.7), hash12(c + 4.1))) * 70.0;
      float radius = mix(1.5, 6.5, hash12(c + 8.3));
      float d = length(p - centre);
      tone *= mix(vec3(1.0), vec3(0.8, 0.62, 0.45), (1.0 - smoothstep(radius * 0.4, radius * 2.4, d)) * 0.7);
    }
  }
  // Water stains: faint tide lines.
  float stain = fbm(p * 0.004 + uSeed + 31.0);
  float tide = smoothstep(0.015, 0.0, abs(stain - 0.58));
  tone *= mix(vec3(1.0), vec3(0.82, 0.7, 0.52), tide * 0.35);
  // A fold across the sheet.
  float fold = (p.y - uFold) / 2.5;
  tone *= 1.0 - 0.08 * exp(-fold * fold) + 0.03 * exp(-(fold - 2.2) * (fold - 2.2));
  // Laid chain lines are a touch more translucent (darker); linen shows its weave faintly.
  float chainTone = exp(-pow((mod(p.x, 96.0) - 48.0) / 3.2, 2.0));
  base *= 1.0 - uLaid * (0.03 * chainTone + 0.005 * (0.5 + 0.5 * sin(p.y * 6.2831 / 4.2)));
  base *= 1.0 - uLinen * 0.02 * (0.5 + 0.5 * sin(p.x * 6.2831 / 3.4) * sin(p.y * 6.2831 / 3.4));
  return base * mix(vec3(1.0), tone, uAge);
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y * uScale - gl_FragCoord.y) / uScale;
  float e = 0.9;
  float h0 = relief(p); float hx = relief(p + vec2(e, 0.0)); float hy = relief(p + vec2(0.0, e));
  vec3 n = normalize(vec3(-(hx - h0) * (1.2 + 3.0 * uCrinkle), -(hy - h0) * (1.2 + 3.0 * uCrinkle), 1.0));
  float lit = (1.0 - exp(-irradiance(vec3(p, 0.0), n) * uExposure)) * uLamp;
  vec2 uv = p / uSize;
  float vignette = smoothstep(0.15, 1.1, length((uv - vec2(0.5, 0.55)) * vec2(1.0, 1.15)));
  float ambient = mix(1.0, uAmbient * (1.0 - 0.3 * vignette), uLamp);
  vec3 irr = uAmbientTint * ambient + (1.0 - ambient) * lit * uTint;
  // Relief catches the room light from the upper left: a few percent, like real fibres.
  // Crinkled cotton: the relief catches light from the upper left (bounded, so ink stays crisp).
  irr *= clamp(1.0 + (-n.x * 0.35 - n.y * 0.55) * (0.6 + 2.2 * uCrinkle), 1.0 - 0.16 * uCrinkle - 0.04, 1.0 + 0.16 * uCrinkle + 0.04);
  // A sheet is never perfectly flat: its side edges fall off gently and darken a little.
  float side = min(uv.x, 1.0 - uv.x) * uSize.x;
  // Pane edge shading is applied once in CSS, not repeated per tile.
  vec3 albedo = parchment(p);
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
  vec3 c = albedo * irr + g * (uGrain * 0.045 + 1.5 / 255.0);
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}