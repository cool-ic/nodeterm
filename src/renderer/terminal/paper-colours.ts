/** Ink colours are checked against a darker region of the actual textured light paper,
 * not its unlit base swatch. Kept out of ordinary and dark themes. */
export const PAPER_CONTRAST_SAMPLE = '#b3aaa0'
function rgb(hex: string): number[] { return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)) }
function luminance(c: number[]): number {
  const v=c.map(x=>{const s=x/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4})
  return v[0]*.2126+v[1]*.7152+v[2]*.0722
}
export function paperInkContrast(hex: string): number {
 const a=luminance(rgb(PAPER_CONTRAST_SAMPLE)),b=luminance(rgb(hex))
 return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
}
export function paperInk(hex: string): string {
 const source=rgb(hex), gray=source[0]*.2126+source[1]*.7152+source[2]*.0722
 // Slightly desaturate emissive terminal colours; keep the original hue family.
 const ink=source.map(c=>c*.84+gray*.16)
 const encode=(scale:number)=>'#'+ink.map(c=>Math.round(c*scale).toString(16).padStart(2,'0')).join('')
 if(paperInkContrast(encode(1))>=5)return encode(1)
 let lo=0,hi=1
 for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(paperInkContrast(encode(mid))>=5)lo=mid;else hi=mid}
 return encode(lo)
}
export const PAPER_EXTENDED_ANSI = Array.from({length:240},(_,offset)=>{
 const i=offset+16, levels=[0,95,135,175,215,255]
 const c=i<232 ? [levels[Math.floor((i-16)/36)],levels[Math.floor((i-16)/6)%6],levels[(i-16)%6]] : [8+(i-232)*10,8+(i-232)*10,8+(i-232)*10]
 return paperInk('#'+c.map(v=>v.toString(16).padStart(2,'0')).join(''))
})
