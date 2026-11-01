import fragment from './reference-fragment.glsl'
const W=680,H=680,DPR=2;
async function run(){
 const images:Record<string,string>={}
 for(const [kind,paper] of Object.entries({cotton:"#eee6d5",linen:"#ebe5d8",moonlit:"#e5e4e0",midnight:"#262431"})){
  const ref = document.createElement('canvas'); ref.width=W*DPR;ref.height=H*DPR
  const gl=ref.getContext('webgl2',{preserveDrawingBuffer:true})!
  const program=gl.createProgram()!
  for (const [type,source] of [[gl.VERTEX_SHADER,'#version 300 es\nin vec2 aPos; void main(){gl_Position=vec4(aPos,0.,1.);}'],[gl.FRAGMENT_SHADER,fragment]] as const) {
    const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader)
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)!)
    gl.attachShader(program,shader)
  }
  gl.bindAttribLocation(program,0,'aPos');gl.linkProgram(program);gl.useProgram(program)
  const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0)
  const f=(n:string,v:number)=>gl.uniform1f(gl.getUniformLocation(program,n),v)
  gl.viewport(0,0,ref.width,ref.height)
  gl.uniform2f(gl.getUniformLocation(program,'uSize'),W,H)
  f('uScale',DPR);f('uSeed',3.7);f('uFold',H*.38);f('uCrinkle',kind==='cotton'?.55:.2);f('uLinen',kind==='cotton'?0:1);f('uMottle',kind==='cotton'?.12:.08);f('uGrain',.1);f('uAmbient',1);f('uLamp',0)
  gl.uniform3f(gl.getUniformLocation(program,'uAmbientTint'),...([14,14,26].map(c=>.84+.6*c/255) as [number,number,number]))
  gl.drawArrays(gl.TRIANGLES,0,3)

 const composed=document.createElement('canvas');composed.width=ref.width;composed.height=ref.height;
 const ctx=composed.getContext('2d')!;ctx.fillStyle=paper;ctx.fillRect(0,0,ref.width,ref.height);ctx.globalCompositeOperation='multiply';ctx.drawImage(ref,0,0);
 images[kind]=composed.toDataURL();gl.getExtension('WEBGL_lose_context')?.loseContext()
 }
 (window as any).testResult({images,facts:{paper:'Cotton/Linen',room:'Moonlit Poetry',lamp:false,referenceFontSize:15,referenceLinePx:22,referenceTileCssPx:680}})
}
run().catch(e=>(window as any).testResult({facts:{error:String(e)}}))
