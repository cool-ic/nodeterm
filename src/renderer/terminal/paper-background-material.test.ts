import {expect,it} from 'vitest'
import {paperRectangleShader,PAPER_MATERIALS,withPaperBackgroundShader} from './paper-background-material'
it('samples the actual sheet material without changing glyph shaders or cell alpha',()=>{
 const source='precision lowp float;\nin vec4 v_color;\nvoid main(){ outColor = v_color; }'
 const patched=paperRectangleShader(source)
 expect(patched).toContain('texture(u_paperTexture, uv)')
 expect(patched).toContain('v_color.a')
 expect(patched).not.toContain('sin(dot')
 expect(paperRectangleShader(patched)).toBe(patched)
 expect(paperRectangleShader('glyph shader')).toBe('glyph shader')
 expect(Object.keys(PAPER_MATERIALS)).toEqual(['cotton','linen','moonlit'])
})
it('activation wrapper preserves exceptions when WebGL is unavailable',()=>{
 expect(()=>withPaperBackgroundShader(()=>{throw Error('activation')})).toThrow('activation')
})
it('restores texture bindings and active unit even when rectangle drawing throws',async()=>{
 const {installPaperBackgroundMaterial}=await import('./paper-background-material')
 let active=3;const bindings=new Map([[7,'original-paper-unit']]);let deleted=0
 const gl:any={ACTIVE_TEXTURE:1,TEXTURE_BINDING_2D:2,TEXTURE0:0,TEXTURE_2D:4,RGBA:5,UNSIGNED_BYTE:6,
  getUniformLocation:()=>({}),getParameter:(p:number)=>p===1?active:bindings.get(active),
  activeTexture:(v:number)=>{active=v},bindTexture:(_t:number,v:any)=>bindings.set(active,v),
  createTexture:()=>({}),deleteTexture:()=>{deleted++},texParameteri:()=>{},texImage2D:()=>{},
  useProgram:()=>{},uniform1i:()=>{},uniform1f:()=>{},uniform3fv:()=>{},uniform4fv:()=>{},canvas:{width:100,height:100}}
 const rr={_gl:gl,_program:{},renderBackgrounds:()=>{throw Error('draw')},renderCursor:()=>{},dispose:()=>{}}
 expect(installPaperBackgroundMaterial({_renderer:{_rectangleRenderer:{value:rr}}},()=>false)).toBe(true)
 expect(()=>rr.renderBackgrounds()).toThrow('draw')
 expect(active).toBe(3);expect(bindings.get(7)).toBe('original-paper-unit')
 rr.dispose();expect(deleted).toBe(1)
})

it('keeps very dark coatings textured in both renderer models without changing light pigments',async()=>{
 const {paperPigment,PAPER_PIGMENT_FLOOR}=await import('./paper-background-material')
 const mean=PAPER_MATERIALS.cotton.mean
 expect(paperPigment([0,0,0],mean)).toEqual(paperPigment([14,14,14],mean))
 expect(paperPigment([200,190,180],mean)).toEqual([200,190,180].map((v,i)=>Math.round(v*255/mean[i])))
 expect(PAPER_PIGMENT_FLOOR).toBe(14)
 const shader=paperRectangleShader('precision lowp float;\nin vec4 v_color;\nvoid main(){ outColor = v_color; }')
 expect(shader).toContain(`vec3(${(PAPER_PIGMENT_FLOOR/255).toFixed(9)}) * v_color.a`)
})
