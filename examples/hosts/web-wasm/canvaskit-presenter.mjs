/** CanvasKit presenter. One complete Rust RenderFrame per submit.
 * Drawing invokes CanvasKit's local renderer bindings; it never calls the
 * AppService/runtime once per node and never uploads a software-composited
 * frame. Typed images remain cached across frames only after their dimensions
 * and complete RGBA bytes match the presenter's owned validation copy.
 */
import { validateTextFlowStyle, validateTextFlowPlan } from './text-flow-plan.mjs';

export class CanvasKitFrameError extends Error {
  constructor(code, message, nodeId = null) {
    super(message); this.name = 'CanvasKitFrameError'; this.code = code; this.nodeId = nodeId;
  }
  toJSON() { return {code:this.code,message:this.message,nodeId:this.nodeId}; }
}

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const fail = (message, node) => { throw new CanvasKitFrameError('ERR_RENDER', message, node?.id ?? null); };
const unsupported = (message, node) => { throw new CanvasKitFrameError('ERR_UNSUPPORTED_CAPABILITY', message, node?.id ?? null); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const renderError = error => error instanceof CanvasKitFrameError ? error : new CanvasKitFrameError('ERR_RENDER',error?.message ?? String(error));
const imageModes = new Set(['scaleToFill','aspectFit','aspectFill','widthFix','heightFix','top','bottom','center','left','right','top left','top right','bottom left','bottom right']);
const imageId = value => typeof value==='string'&&value.length>0&&value.length<=256&&!/[^A-Za-z0-9._:/-]/.test(value);
// Empty Canvas declarations paint as ordinary layout slots and grant no
// drawing authority. The runtime alone strips guest reserved resources and
// attaches exact owned bindings before exporting this accepted frame.
const ownedCanvasImage = (image, images) => record(image)
  && typeof image.resource==='string' && /^weapp-owned-canvas:[1-9][0-9]*$/.test(image.resource)
  && image.mode==='scaleToFill' && Object.hasOwn(images,image.resource);
const maxImageCacheBytes=64*1024*1024,maxImageCacheEntries=1024;
function sameImage(entry,resource) {
  if(!entry||entry.width!==resource.width||entry.height!==resource.height||entry.pixels.length!==resource.pixels.length)return false;
  const a=entry.pixels,b=resource.pixels;
  if(a instanceof Uint8Array&&b instanceof Uint8Array&&a.byteOffset%4===0&&b.byteOffset%4===0&&a.byteLength%4===0){
    // Compare the complete immutable cache copy, four bytes at a time. Both
    // views use the same native endianness; every RGBA byte still participates.
    const left=new Uint32Array(a.buffer,a.byteOffset,a.byteLength/4),right=new Uint32Array(b.buffer,b.byteOffset,b.byteLength/4);
    for(let index=0;index<left.length;index++)if(left[index]!==right[index])return false;
  }else for(let index=0;index<a.length;index++)if(a[index]!==b[index])return false;
  return true;
}
function validateImages(frame,stats) {
  const resources=frame.images===undefined?{}:frame.images;
  if(!record(resources))fail('frame images must be a resource table');
  const entries=Object.entries(resources);
  if(entries.length>1024)fail('frame image resource limit exceeded');
  for(const [id,image] of entries) {
    if(!imageId(id)||!record(image))fail('invalid image resource');
    if(![image.width,image.height].every(value=>Number.isInteger(value)&&value>0&&value<=8192))fail('invalid image dimensions');
    const size=image.width*image.height*4;
    if(size>64*1024*1024)fail('image pixel limit exceeded');
    stats.imageBytes+=size;
    if(stats.imageBytes>128*1024*1024)fail('frame image byte limit exceeded');
    if(!(Array.isArray(image.pixels)||image.pixels instanceof Uint8Array)||image.pixels.length!==size)fail('image RGBA byte length differs');
  }
  // Check every index, including holes. Array.every would silently accept a
  // sparse array that cannot represent the committed unpremultiplied RGBA8.
  for(const [,image] of entries) {
    // Uint8Array elements already have the required integer/range semantics.
    // Legacy JSON arrays still need a complete check, including sparse holes.
    if(image.pixels instanceof Uint8Array)continue;
    for(let index=0;index<image.pixels.length;index++) {
      const value=image.pixels[index];
      if(!Number.isInteger(value)||value<0||value>255)fail('invalid image RGBA byte');
    }
  }
  stats.imageResources=entries.length;
  return resources;
}
function imageGeometry(image,mode,content) {
  const {width,height}=image,{x,y,width:w,height:h}=content;
  if(w===0||h===0)return null;
  let source=[0,0,width,height],destination=[x,y,x+w,y+h];
  if(mode==='aspectFit') {
    const scale=Math.min(w/width,h/height),dw=width*scale,dh=height*scale;
    destination=[x+(w-dw)/2,y+(h-dh)/2,x+(w+dw)/2,y+(h+dh)/2];
  } else if(mode==='aspectFill') {
    const scale=Math.max(w/width,h/height),sw=w/scale,sh=h/scale;
    source=[(width-sw)/2,(height-sh)/2,(width+sw)/2,(height+sh)/2];
  } else if(!['scaleToFill','widthFix','heightFix'].includes(mode)) {
    const align={top:[.5,0],bottom:[.5,1],center:[.5,.5],left:[0,.5],right:[1,.5],
      'top left':[0,0],'top right':[1,0],'bottom left':[0,1],'bottom right':[1,1]}[mode];
    const sw=Math.min(width,w),sh=Math.min(height,h),[ax,ay]=align;
    const sx=(width-sw)*ax,sy=(height-sh)*ay,dx=x+(w-sw)*ax,dy=y+(h-sh)*ay;
    source=[sx,sy,sx+sw,sy+sh];destination=[dx,dy,dx+sw,dy+sh];
  }
  return {source,destination};
}
function release(...resources) {
  const errors=[];
  for(const resource of resources)try{resource?.delete();}catch(error){errors.push(error.message??String(error));}
  if(errors.length)fail(`CanvasKit temporary cleanup failed: ${errors.join('; ')}`);
}
function finite(value, name, node) { if (!Number.isFinite(value)) fail(`${name} must be finite`, node); return value; }
function rect(bounds, node) {
  if (!bounds || !['x','y','width','height'].every(k=>Number.isFinite(bounds[k]))) fail('invalid node bounds', node);
  if (bounds.width < 0 || bounds.height < 0) fail('negative node bounds', node);
  return [bounds.x,bounds.y,finite(bounds.x+bounds.width,'bounds.right',node),finite(bounds.y+bounds.height,'bounds.bottom',node)];
}
function normalizeRadii(bounds,corners,node) {
  let r = corners.map(p=>({x:Math.max(0,finite(p.x,'radius.x',node)),y:Math.max(0,finite(p.y,'radius.y',node))}));
  let scale = 1;
  for (const [extent,sum] of [[bounds.width,r[0].x+r[1].x],[bounds.height,r[1].y+r[2].y],[bounds.width,r[2].x+r[3].x],[bounds.height,r[3].y+r[0].y]]) {
    if (sum > 0) scale=Math.min(scale,extent/sum);
  }
  return r.flatMap(p=>[p.x*scale,p.y*scale]);
}
function radii(node) {
  const corners=node.style?.border_radius ?? Array.from({length:4},()=>({x:0,y:0}));
  if (!Array.isArray(corners)||corners.length!==4||corners.some(p=>!record(p))) fail('four corner radii required',node);
  return normalizeRadii(node.bounds,corners,node);
}
function borders(node) {
  const sides=node.style?.border;
  if(sides===undefined)return Array.from({length:4},()=>({width:0,color:{red:0,green:0,blue:0,alpha:255},style:'none'}));
  if(!Array.isArray(sides)||sides.length!==4||sides.some(side=>!record(side)))fail('four typed border sides required',node);
  return sides.map(side=>{
    if(!Number.isFinite(side.width)||side.width<0||!Number.isFinite(Math.fround(side.width)))fail('invalid border width',node);
    validateColor(side.color,node);
    if(!['none','hidden','solid','dashed','dotted','double','groove','ridge','inset','outset'].includes(side.style))fail('invalid border style',node);
    if(!['none','hidden','solid'].includes(side.style))unsupported(`border-style:${side.style} painting is unavailable`,node);
    return {...side,width:side.style==='solid'?side.width:0};
  });
}
function boxGeometry(node) {
  const sides=borders(node), outer=rect(node.bounds,node), outerRadii=radii(node);
  const widths=sides.map(side=>side.width);
  if(!Number.isFinite(Math.fround(widths[3]+widths[1]))||!Number.isFinite(Math.fround(widths[0]+widths[2]))) {
    fail('opposing border widths exceed finite Skia insets',node);
  }
  const scaleX=widths[3]+widths[1]>0?Math.min(1,node.bounds.width/(widths[3]+widths[1])):1;
  const scaleY=widths[0]+widths[2]>0?Math.min(1,node.bounds.height/(widths[0]+widths[2])):1;
  const [top,right,bottom,left]=widths.map((width,index)=>width*(index%2===0?scaleY:scaleX));
  const innerBounds={x:outer[0]+left,y:outer[1]+top,width:Math.max(0,node.bounds.width-left-right),height:Math.max(0,node.bounds.height-top-bottom)};
  const inner=rect(innerBounds,node),innerRadii=normalizeRadii(innerBounds,[
    {x:Math.max(0,outerRadii[0]-left),y:Math.max(0,outerRadii[1]-top)},
    {x:Math.max(0,outerRadii[2]-right),y:Math.max(0,outerRadii[3]-top)},
    {x:Math.max(0,outerRadii[4]-right),y:Math.max(0,outerRadii[5]-bottom)},
    {x:Math.max(0,outerRadii[6]-left),y:Math.max(0,outerRadii[7]-bottom)},
  ],node);
  const padding=node.style?.padding===undefined?{}:node.style.padding;
  if(!record(padding))fail('invalid padding',node);
  const inset=['top','right','bottom','left'].map(name=>{
    const value=padding[name]===undefined?0:padding[name];
    if(!Number.isFinite(value)||value<0)fail('invalid padding inset',node);
    return value;
  });
  const content={x:inner[0]+inset[3],y:inner[1]+inset[0],width:Math.max(0,innerBounds.width-inset[1]-inset[3]),height:Math.max(0,innerBounds.height-inset[0]-inset[2])};
  rect(content,node);
  for(const value of [...outer,...inner,...innerRadii,...Object.values(content)]) {
    if(!Number.isFinite(Math.fround(value)))fail('border box exceeds finite Skia coordinates',node);
  }
  return {sides,outer,outerRadii,inner,innerRadii,content,widths:[top,right,bottom,left]};
}
function borderPolygon(geometry,side) {
  const {outer,widths}=geometry,width=outer[2]-outer[0],height=outer[3]-outer[1];
  if(widths[side]===0)return [];
  // Partition the entire outer rectangle by min(distance / used side width).
  // Joining outer corners only to inner rectangle corners misses the rounded
  // inner-corner ring. Convex half-planes also cover that part of the ring.
  const distance=[[0,1,0],[-1,0,width],[0,-1,height],[1,0,0]];
  let polygon=[[0,0],[width,0],[width,height],[0,height]];
  for(let other=0;other<4&&polygon.length>0;other++) {
    if(other===side||widths[other]===0)continue;
    const line=distance[side].map((coefficient,index)=>coefficient*widths[other]-distance[other][index]*widths[side]);
    const signed=point=>line[0]*point[0]+line[1]*point[1]+line[2];
    const clipped=[];
    let previous=polygon.at(-1),previousValue=signed(previous);
    for(const current of polygon) {
      const currentValue=signed(current);
      if((previousValue<=0)!==(currentValue<=0)) {
        const t=previousValue/(previousValue-currentValue);
        clipped.push([previous[0]+(current[0]-previous[0])*t,previous[1]+(current[1]-previous[1])*t]);
      }
      if(currentValue<=0)clipped.push(current);
      previous=current;previousValue=currentValue;
    }
    polygon=clipped;
  }
  return polygon.map(([x,y])=>[outer[0]+x,outer[1]+y]);
}
function validateUntypedBorders(node) {
  if(node.style?.border!==undefined)return;
  const computed=node.computed_style??{},edges=['top','right','bottom','left'];
  // Rust omits four default BorderSide values during serialization. A real
  // `border:0 none black` therefore has no typed field, while its normalized
  // color longhands remain. Decide from the complete used width/style tuple,
  // never from a color string considered independently.
  if(edges.every(edge=>computed[`border-${edge}-width`]!==undefined&&computed[`border-${edge}-style`]!==undefined)) {
    for(const edge of edges) {
      const raw=computed[`border-${edge}-width`].trim().toLowerCase(),style=computed[`border-${edge}-style`].trim().toLowerCase();
      const keywords={thin:1,medium:3,thick:5};
      const match=raw.match(/^((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:px|rpx|rem|em|vh|vw|vmin|vmax)?$/i);
      const width=keywords[raw]??(match?Number(match[1]):NaN);
      if(!Number.isFinite(width)||!Number.isFinite(Math.fround(width)))fail('invalid computed border width',node);
      if(!['none','hidden','solid','dashed','dotted','double','groove','ridge','inset','outset'].includes(style))fail('invalid computed border style',node);
      if(!['none','hidden','solid'].includes(style))unsupported(`border-style:${style} painting is unavailable`,node);
      if(width!==0&&style==='solid')unsupported(`border-${edge} requires the typed border frame contract`,node);
    }
    return;
  }
  // Older partial frames lack enough information to prove used widths. Keep
  // their existing conservative zero/none admission; a nonzero legacy border
  // must not be silently interpreted as the absent typed default.
  for(const [property,value] of Object.entries(computed)) {
    if((property==='border'||property.startsWith('border-'))&&!property.includes('radius')
      &&!/^(?:(?:none|hidden|0(?:px)?)(?:\s+|$))+$/i.test(value.trim())) {
      unsupported(`${property} requires the typed border frame contract`,node);
    }
  }
}
function localMatrix(node) {
  const t = node.style?.transform;
  if (!t) return identity;
  if (!record(t)) fail('invalid transform',node);
  for (const k of ['a','b','c','d','e','f']) finite(t[k],`transform.${k}`,node);
  const o=node.style?.transform_origin;
  if (o!=null&&!record(o)) fail('invalid transform origin',node);
  const point=(axis,boundsOrigin,extent)=>{
    if(axis!=null&&(!record(axis)||!['percent','px'].includes(axis.unit)))fail('invalid transform origin unit',node);
    const value=Math.fround(finite(axis==null?50:axis.value,'transform origin',node));
    const start=Math.fround(boundsOrigin),size=Math.fround(extent);
    const offset=(axis?.unit??'percent')==='percent'?Math.fround(size*Math.fround(value/100)):value;
    return Math.fround(start+offset);
  };
  const x=point(o?.x,node.bounds.x,node.bounds.width), y=point(o?.y,node.bounds.y,node.bounds.height);
  const matrix=[t.a,t.c,t.e,t.b,t.d,t.f,0,0,1].map(Math.fround);
  // Match both rounded Rust products. Collapsing the origin sandwich into
  // one formula would retain precision already lost by the first product.
  return multiply(multiply([1,0,x,0,1,y,0,0,1],matrix,node),[1,0,-x,0,1,-y,0,0,1],node);
}
function multiply(parent,local,node) {
  return [
    parent[0]*local[0]+parent[1]*local[3],parent[0]*local[1]+parent[1]*local[4],parent[0]*local[2]+parent[1]*local[5]+parent[2],
    parent[3]*local[0]+parent[4]*local[3],parent[3]*local[1]+parent[4]*local[4],parent[3]*local[2]+parent[4]*local[5]+parent[5],0,0,1,
  ].map(value=>{
    finite(value,'accumulated transform',node);
    const represented=Math.fround(value);
    if(!Number.isFinite(represented)||(value!==0&&represented===0))
      fail('accumulated transform exceeds finite Skia coordinates',node);
    return represented;
  });
}
const determinant = matrix => matrix[0]*matrix[4]-matrix[1]*matrix[3];
// As in Rust, compute products in f64. A small nonzero determinant is not
// singular, and the determinant need not itself fit in a Skia f32 coordinate.
const invertible = matrix => determinant(matrix)!==0;
const viewportFixed = node => node.style?.flow != null && node.style?.position === 'fixed';
const siblingOrder = (parent,child) => parent.style?.flow?.context==='flex'&&!['absolute','fixed'].includes(child.style?.position)?child.style?.flow?.order??0:0;
function inverse(matrix,node) {
  const det=finite(determinant(matrix),'transform determinant',node);
  if(!invertible(matrix))fail('non-invertible clip transform',node);
  return [matrix[4]/det,-matrix[1]/det,(matrix[1]*matrix[5]-matrix[4]*matrix[2])/det,
    -matrix[3]/det,matrix[0]/det,(matrix[3]*matrix[2]-matrix[0]*matrix[5])/det,0,0,1]
    .map(value=>{const result=Math.fround(value);if(!Number.isFinite(result))fail('transform inverse exceeds finite Skia coordinates',node);return result;});
}
function descendantClip(node,viewport,matrix) {
  const axes=overflow(node);
  if(!axes.x&&!axes.y)return null;
  const geometry=boxGeometry(node),bounds=geometry.inner;
  if(axes.x&&axes.y)return {bounds,radii:geometry.innerRadii};
  if(!invertible(matrix))return null;
  // A one-axis clip is an infinite strip in this node's local coordinates.
  // Its other extent only needs to cover the logical viewport, transformed
  // back through every ancestor. No large float sentinel or device-space
  // axis-aligned approximation may clip a rotated/scaled descendant.
  const inverted=inverse(matrix,node);
  const corners=[[viewport.x,viewport.y],[viewport.x+viewport.width,viewport.y],
    [viewport.x+viewport.width,viewport.y+viewport.height],[viewport.x,viewport.y+viewport.height]]
    .map(([x,y])=>[inverted[0]*x+inverted[1]*y+inverted[2],inverted[3]*x+inverted[4]*y+inverted[5]]);
  const local=[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];
  // Keep the irrelevant strip ends outside the viewport, including Skia's
  // edge quantization. The padding changes no in-viewport clipping semantics.
  const padX=Math.max(1,(local[2]-local[0])*1e-6),padY=Math.max(1,(local[3]-local[1])*1e-6);
  const clip=[axes.x?bounds[0]:local[0]-padX,axes.y?bounds[1]:local[1]-padY,axes.x?bounds[2]:local[2]+padX,axes.y?bounds[3]:local[3]+padY];
  for(const value of clip)if(!Number.isFinite(Math.fround(value)))fail('overflow clip exceeds finite Skia coordinates',node);
  return {bounds:clip,radii:null};
}
function scrollTranslation(node) {
  if(node.scrollContainer!==undefined&&typeof node.scrollContainer!=='boolean')fail('scrollContainer must be a boolean',node);
  if(node.scrollOffset!=null) {
    if(!record(node.scrollOffset))fail('invalid scroll offset',node);
    for(const [name,value] of Object.entries({scrollLeft:node.scrollOffset.scrollLeft===undefined?0:node.scrollOffset.scrollLeft,scrollTop:node.scrollOffset.scrollTop===undefined?0:node.scrollOffset.scrollTop})) {
      if(!Number.isFinite(value)||value<0||!Number.isFinite(Math.fround(value)))fail(`${name} must be finite and non-negative`,node);
    }
  }
  if(!node.scrollContainer)return identity;
  return [1,0,-(node.scrollOffset?.scrollLeft??0),0,1,-(node.scrollOffset?.scrollTop??0),0,0,1];
}
function validateColor(value,node) {
  if (!record(value)||!['red','green','blue','alpha'].every(k=>Number.isInteger(value[k])&&value[k]>=0&&value[k]<=255)) fail('invalid RGBA colour',node);
}
function textStyle(node) {
  const style=node.text_style;
  if(style==null)return {fontSize:16,lineHeight:19.2,resolved:false};
  if(!record(style)||!Number.isFinite(style.font_size)||style.font_size<0||!Number.isFinite(Math.fround(style.font_size)))fail('invalid resolved font size',node);
  let lineHeight;
  if(style.line_height==='normal')lineHeight=style.font_size*1.2;
  else if(record(style.line_height)&&Object.keys(style.line_height).length===1) {
    if(Object.hasOwn(style.line_height,'number'))lineHeight=style.font_size*style.line_height.number;
    else if(Object.hasOwn(style.line_height,'px'))lineHeight=style.line_height.px;
  }
  if(!Number.isFinite(lineHeight)||lineHeight<0||!Number.isFinite(Math.fround(lineHeight)))fail('invalid resolved line height',node);
  // A unitless negative multiplier is invalid even at font-size:0.
  if(record(style.line_height)&&Object.values(style.line_height).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0))fail('invalid resolved line height',node);
  if(style.flow!=null) {
    try {validateTextFlowStyle(style.flow);} catch(error) {fail(error.message,node);}
  }
  return {fontSize:style.font_size,lineHeight,resolved:true,flow:style.flow??null};
}
const invisibleFlowCharacter = character => /^[\u200b\u200c\u200d\u2060\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]$/u.test(character);
function validateTextLayout(node,stats,content,fontIdentity) {
  const style=textStyle(node),layout=node.text_layout;
  if(layout==null) {
    if(fontIdentity&&node.text)unsupported('verified font drawing requires a committed font-bound layout',node);
    if(style.flow!=null&&node.text!=null)unsupported('CSS text flow requires a committed source-mapped layout',node);
    return style;
  }
  const binding=record(layout?.measurement)?layout.measurement.font:null;
  const fontBound=record(binding)&&Object.keys(layout.measurement).length===1&&Object.keys(binding).length===3
    &&typeof binding.sha256==='string'&&/^[a-f0-9]{64}$/.test(binding.sha256)&&binding.face_index===0&&binding.profile==='sfnt-unhinted-v1';
  if(!record(layout)||!record(layout.metrics)||!Array.isArray(layout.glyphs)||!(['native','fallback'].includes(layout.measurement)||fontBound))fail('invalid committed text layout',node);
  if(fontBound&&(!fontIdentity||['sha256','face_index','profile'].some(key=>binding[key]!==fontIdentity[key])))fail('committed layout belongs to a different font/measurement profile',node);
  if(fontIdentity&&!fontBound)fail('renderer font requires its exact committed metrics binding',node);
  if(!style.resolved||typeof node.text!=='string')fail('committed text layout requires text and resolved text_style',node);
  const {width,height,line_count:lineCount}=layout.metrics;
  for(const [name,value] of [['width',width],['height',height]]) {
    if(!Number.isFinite(value)||value<0||!Number.isFinite(Math.fround(value)))fail(`invalid text metrics ${name}`,node);
  }
  if(!Number.isSafeInteger(lineCount)||lineCount<(layout.flow!=null?0:1))fail('invalid text line count',node);
  stats.committedGlyphs+=layout.glyphs.length;
  if(stats.committedGlyphs>1000000)fail('frame committed glyph limit exceeded',node);
  if(layout.flow!=null||style.flow!=null) {
    try {validateTextFlowPlan(node.text,node.text_style,layout);} catch(error) {fail(error.message,node);}
    if(node.children.length===0&&(layout.flow.available_width==null
      ||Math.fround(layout.flow.available_width)!==Math.fround(content.width)
      ||layout.flow.offset_x!==0||layout.flow.offset_y!==0))fail('leaf text flow does not match its content box',node);
  }
  const characters=layout.flow!=null?layout.glyphs.map(glyph=>glyph.character):[...node.text].filter(character=>!['\r','\n','\t'].includes(character));
  if(characters.length!==layout.glyphs.length)fail('committed glyphs do not match text',node);
  for(let index=0;index<layout.glyphs.length;index++) {
    const glyph=layout.glyphs[index];
    if(!record(glyph)||typeof glyph.character!=='string'||[...glyph.character].length!==1
      ||glyph.character!==characters[index]||/^[\uD800-\uDFFF]$/.test(glyph.character))fail('invalid committed glyph character',node);
    if(!Number.isFinite(glyph.x)||(layout.flow==null&&glyph.x<0)||!Number.isFinite(Math.fround(glyph.x))
      ||!Number.isFinite(glyph.baseline_y)||!Number.isFinite(Math.fround(glyph.baseline_y)))fail('invalid committed glyph position',node);
    if(!Number.isFinite(Math.fround(content.x+glyph.x))||!Number.isFinite(Math.fround(content.y+glyph.baseline_y)))fail('committed glyph exceeds finite Skia coordinates',node);
  }
  return style;
}
function color(CK, value, opacity, node) {
  validateColor(value,node);
  return CK.Color(value.red,value.green,value.blue,value.alpha/255*opacity);
}
// Rust commits opacity as f32 and rounds the f32 product once at the group
// boundary. JSON's shortest decimal becomes an f64 here; casting both before
// and after multiplication preserves half-step alpha values across the wire.
function opacityAlpha(opacity) {
  return Math.round(Math.fround(Math.fround(opacity)*255));
}
function overflow(node) {
  const c=node.computed_style??{}, parts=(c.overflow??'visible').trim().toLowerCase().split(/\s+/);
  if(parts.length>2)fail('invalid overflow declaration',node);
  let x=(c['overflow-x']??parts[0]).trim().toLowerCase(),y=(c['overflow-y']??parts[1]??parts[0]).trim().toLowerCase();
  const scrolling=v=>['hidden','scroll','auto'].includes(v);
  if (![x,y].every(v=>['visible','hidden','clip','scroll','auto'].includes(v))) unsupported('unrecognized overflow mode',node);
  return {x:node.scrollContainer===true||scrolling(x)||x==='clip'||x==='visible'&&scrolling(y),y:node.scrollContainer===true||scrolling(y)||y==='clip'||y==='visible'&&scrolling(x)};
}

const pathKey = path => path.join('/');
const newStackingMetadata = node => node.style!=null&&(Object.hasOwn(node.style,'z_index')||Object.hasOwn(node.style,'isolation'));
function validateStackingMetadata(node) {
  if(node.style!=null&&!record(node.style))fail('invalid node style',node);
  if(node.style!=null&&Object.hasOwn(node.style,'z_index')&&(!Number.isInteger(node.style.z_index)
    ||node.style.z_index< -2147483648||node.style.z_index>2147483647))fail('invalid typed stacking z_index: expected i32 integer',node);
  if(node.style!=null&&Object.hasOwn(node.style,'isolation')&&typeof node.style.isolation!=='boolean')fail('invalid typed stacking isolation: expected boolean',node);
  if(node.style?.position!=null&&!['static','relative','absolute','fixed'].includes(node.style.position))fail('invalid positioning mode',node);
}
function stackingContext(node,parent) {
  const position=node.style?.position??'static';
  const flexItem=parent?.style?.flow?.context==='flex'&&!['absolute','fixed'].includes(position);
  const explicit=node.style?.z_index!==undefined;
  return parent===null||position==='fixed'||node.style?.transform!=null||node.opacity<1
    ||node.style?.isolation===true||explicit&&(position!=='static'||flexItem);
}
function legacyStackingBoundary(node) {
  if(newStackingMetadata(node))unsupported('typed stacking metadata requires a committed paintPlan',node);
  node.children.forEach(legacyStackingBoundary);
}

// This table follows spatial ancestry independently of committed paint order.
// Absolute descendants inherit their containing block's world/scroll space and
// clip chain; inherited colour and opacity ownership still follow the DOM.
function paintSpaces(frame) {
  const spaces=new Map();let pathEntries=0;
  const visit=(node,path,parent)=>{
    // Match Rust's aggregate DOM-path budget, including hidden subtrees. A
    // node's path counts once, independently of its two/four plan commands.
    pathEntries+=path.length;
    if(spaces.size>=100000||path.length>256||pathEntries>1000000)fail('paintPlan node/depth/path entry budget exceeded',node);
    if(!record(node)||typeof node.id!=='string'||!Array.isArray(node.children))fail('invalid paintPlan render tree',node);
    rect(node.bounds,node);finite(node.opacity,'opacity',node);
    if(node.opacity<0||node.opacity>1)fail('opacity out of range',node);
    validateStackingMetadata(node);
    const fixed=viewportFixed(node),absolute=node.style?.position==='absolute';
    const matrix=multiply(fixed?identity:absolute?parent.absoluteMatrix:parent.matrix,localMatrix(node),node);
    if(fixed&&parent.transformedAncestor)unsupported('fixed positioning inside a transformed containing block is unavailable',node);
    const clips=fixed?[]:node.style?.position==='absolute'?parent.absoluteClips:parent.clips;
    const displayed=parent.displayed&&node.style?.display!=='none';
    const context=stackingContext(node,parent.space?.node??null);
    const contextParent=parent.space?.contextOwner??null;
    const space={node,path,matrix,clips,displayed,visible:node.visibility!=='hidden',context,contextParent,foreground:node.foreground??parent.foreground,
      active:parent.active&&displayed&&node.opacity>0&&invertible(matrix)};
    space.contextOwner=context?space:contextParent;
    spaces.set(pathKey(path),space);
    const clip=descendantClip(node,frame.viewport,matrix);
    const childClips=clip?[...clips,{...clip,matrix}]:clips;
    const containing=path.length===0||(node.style?.position??'static')!=='static'||node.style?.transform!=null;
    const descendantMatrix=multiply(matrix,scrollTranslation(node),node);
    const child={matrix:descendantMatrix,clips:childClips,
      absoluteMatrix:containing?descendantMatrix:parent.absoluteMatrix,
      absoluteClips:containing?childClips:parent.absoluteClips,
      transformedAncestor:parent.transformedAncestor||node.style?.transform!=null,
      displayed,active:space.active,foreground:space.foreground,space};
    node.children.forEach((childNode,index)=>visit(childNode,[...path,index],child));
  };
  visit(frame.root,[],{matrix:identity,absoluteMatrix:identity,clips:[],absoluteClips:[],displayed:true,active:true,transformedAncestor:false,
    foreground:{red:0,green:0,blue:0,alpha:255},space:null});
  return spaces;
}

function validatePaintPlan(frame) {
  const plan=frame.paintPlan;
  if(!record(plan)||Object.keys(plan).some(key=>!['version','commands'].includes(key))
    ||plan.version!==1||!Array.isArray(plan.commands))fail('invalid paintPlan version or commands');
  const spaces=paintSpaces(frame),limit=spaces.size*4;
  if(plan.commands.length<2||plan.commands.length>limit)fail('paintPlan command count exceeds node bound');
  const entries=[],stack=[],counts=new Map();
  for(let index=0;index<plan.commands.length;index++) {
    const command=plan.commands[index];
    if(!record(command)||Object.keys(command).length!==2||!Object.hasOwn(command,'op')||!Object.hasOwn(command,'path')
      ||!['begin','background','content','end'].includes(command.op)||!Array.isArray(command.path)
      ||command.path.length>256)fail('invalid paintPlan command');
    for(let part=0;part<command.path.length;part++) {
      if(!Number.isSafeInteger(command.path[part])||command.path[part]<0)fail('invalid paintPlan path');
    }
    const key=pathKey(command.path),space=spaces.get(key);
    if(!space||!space.displayed&&command.path.length!==0)fail('paintPlan path does not name a displayed node');
    const count=counts.get(key)??{begin:0,background:0,content:0,end:0};
    if(++count[command.op]!==1)fail('duplicate paintPlan node operation',space.node);
    counts.set(key,count);
    if(command.op==='begin') {
      if(!space.context||stack.at(-1)!==(space.contextParent??undefined))fail('paintPlan context nesting differs from DOM context ancestry',space.node);
      if(index!==0&&command.path.length===0)fail('paintPlan root context must begin first');
      if(count.background||count.content||count.end)fail('paintPlan context begins after its paint',space.node);
      stack.push(space);
      const next=plan.commands[index+1];
      if(space.displayed&&space.visible&&(!record(next)||next.op!=='background'||!Array.isArray(next.path)
        ||pathKey(next.path)!==key))fail('paintPlan context background must follow begin',space.node);
    } else if(command.op==='end') {
      if(!space.context||stack.at(-1)!==space)fail('paintPlan context end is unbalanced',space.node);
      if(space.displayed&&space.visible&&(!count.background||!count.content))fail('paintPlan context closes before its paint',space.node);
      stack.pop();
      if(command.path.length===0&&index!==plan.commands.length-1)fail('paintPlan root context must end last');
    } else {
      if(!space.displayed||!space.visible||stack.at(-1)!==space.contextOwner)fail('paintPlan paint is outside its DOM context',space.node);
      if(command.op==='content'&&!count.background)fail('paintPlan content precedes background',space.node);
      if(count.end)fail('paintPlan paint follows its context end',space.node);
    }
    entries.push({op:command.op,space});
  }
  if(stack.length||entries[0].op!=='begin'||entries[0].space.path.length
    ||entries.at(-1).op!=='end'||entries.at(-1).space.path.length)fail('paintPlan requires a balanced root context');
  for(const [key,space] of spaces) {
    const count=counts.get(key);
    if(space.displayed&&space.visible&&(!count||count.background!==1||count.content!==1))fail('paintPlan omits displayed node paint',space.node);
    const expectedContext=space.context&&(space.displayed||space.path.length===0)?1:0;
    if((count?.begin??0)!==expectedContext||(count?.end??0)!==expectedContext)
      fail('paintPlan context operations differ from typed stacking metadata',space.node);
  }
  return entries;
}

export class CanvasKitFramePresenter {
  static async create(CanvasKit, canvas, fontData, options={}) {
    const presenter = new CanvasKitFramePresenter(CanvasKit,canvas,options);
    try {
      if(options.fontIdentity) {
        const identity=options.fontIdentity;
        if(!record(identity)||Object.keys(identity).length!==3||identity.face_index!==0||identity.profile!=='sfnt-unhinted-v1'
          ||typeof identity.sha256!=='string'||!/^[a-f0-9]{64}$/.test(identity.sha256))fail('invalid exact font metrics identity');
        if(!(fontData instanceof ArrayBuffer)||fontData.byteLength===0||fontData.byteLength>32*1024*1024)fail('bounded font bytes required');
        fontData=fontData.slice(0);
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',fontData)),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(digest!==identity.sha256)fail('painter font differs from committed layout font');
        presenter.fontIdentity=Object.freeze({...identity});
      }
      presenter.initialize(fontData); return presenter;
    }
    catch(error) {
      try {presenter.dispose();}catch(cleanupError){throw new CanvasKitFrameError('ERR_RENDER',`${renderError(error).message}; ${cleanupError.message}`);}
      throw renderError(error);
    }
  }
  constructor(CK,canvas,options) {
    if(!['native-v1','strict-css'].includes(options.typography??'native-v1'))fail('unknown typography contract');
    const imageCacheBytes=options.imageCacheBytes??maxImageCacheBytes;
    if(!Number.isSafeInteger(imageCacheBytes)||imageCacheBytes<0||imageCacheBytes>maxImageCacheBytes)fail('invalid image cache byte budget');
    this.CK=CK;this.canvas=canvas;this.options={typography:'native-v1',...options};this.disposed=false;this.surface=null;this.context=null;this.typeface=null;this.font=null;this.contextHandle=0;
    this.imageCache=new Map();this.imageCacheBytes=0;this.imageCacheBudget=imageCacheBytes;this.resourceCleanupErrors=[];
    this.generation=0;this.lost=false;this.lastReceipt=null;
    this.onLost=event=>{
      event.preventDefault();this.lost=true;
      try {this.clearImageCache();} catch(error) {this.resourceCleanupErrors.push(error.message??String(error));}
    };
    canvas.addEventListener('webglcontextlost',this.onLost);
  }
  initialize(fontData) {
    const CK=this.CK;
    if(!(Number.isInteger(this.canvas.width)&&this.canvas.width>0&&Number.isInteger(this.canvas.height)&&this.canvas.height>0))fail('non-empty physical canvas required');
    this.physicalSize=[this.canvas.width,this.canvas.height];
    // MakeWebGLCanvasSurface can silently use CPU on some CanvasKit builds.
    // Explicit context + onscreen GL surface has no software fallback path.
    this.contextHandle=CK.GetWebGLContext(this.canvas,{majorVersion:2,alpha:true,antialias:false,preserveDrawingBuffer:true});
    if (!Number.isInteger(this.contextHandle)||this.contextHandle<=0) fail('WebGL2 context creation failed');
    this.gl=this.canvas.getContext('webgl2');
    if (!this.gl || this.gl.isContextLost()) fail('created WebGL2 context is unavailable');
    this.context=CK.MakeWebGLContext(this.contextHandle);
    if (!this.context) fail('CanvasKit Ganesh context creation failed');
    this.surface=CK.MakeOnScreenGLSurface(this.context,this.canvas.width,this.canvas.height,CK.ColorSpace.SRGB);
    if (!this.surface || this.surface.reportBackendTypeIsGPU()!==true) fail('CanvasKit requires a real GPU-backed WebGL surface');
    this.typeface=CK.Typeface.MakeTypefaceFromData(fontData);
    if (!this.typeface) fail('supplied font did not decode');
    this.font=new CK.Font(this.typeface,16);this.font.setSubpixel(true);
    if(this.fontIdentity) {
      if(typeof this.font.setLinearMetrics!=='function'||typeof this.font.setHinting!=='function'||CK.FontHinting?.None==null)fail('CanvasKit lacks the negotiated unhinted font metrics profile');
      this.font.setLinearMetrics(true);this.font.setHinting(CK.FontHinting.None);
    }
  }
  contextInfo() {
    this.assertAvailable();
    const gl=this.gl, debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {
      api:'webgl2',version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
      unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,
      unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
      surfaceIsGpu:this.surface.reportBackendTypeIsGPU(),contextLost:gl.isContextLost(),
      physicalHardware:'unknown', // SwiftShader/ANGLE/driver provenance is recorded, never inferred as physical device proof.
    };
  }
  assertAvailable() {
    if(this.disposed||this.lost||!this.surface||!this.font||this.gl.isContextLost())fail('WebGL surface unavailable or context lost');
    if(this.canvas.width!==this.physicalSize[0]||this.canvas.height!==this.physicalSize[1])fail('canvas resized; dispose and recreate the presenter');
  }
  validate(frame) {
    this.assertAvailable();
    if(!record(frame)||!Number.isSafeInteger(frame.frame_id)||frame.frame_id<0)fail('invalid frame id');
    rect(frame.viewport);
    if (!(frame.viewport.width>0&&frame.viewport.height>0)) fail('non-empty logical viewport required');
    if(frame.viewport.x!==0||frame.viewport.y!==0)unsupported('non-zero viewport origin is not implemented');
    const stats={nodes:0,textNodes:0,glyphs:0,drawCommands:0,committedGlyphs:0,imageNodes:0,imageResources:0,imageBytes:0,opacityGroups:0,maxOpacityDepth:0,opacityBackingBytes:0,textPlans:{native:0,fallback:0,local:0,legacy:0},semanticGaps:[]};
    const images=validateImages(frame,stats);
    const cssPaintPlan=Object.hasOwn(frame,'paintPlan');
    const visit=(node,depth,parentMatrix,absoluteParentMatrix,transformedAncestor,opacityDepth,paintActive,layoutActive)=>{
      if(!record(node)||typeof node.id!=='string')fail('invalid render node');
      if (++stats.nodes>100000||depth>256) fail('frame node/depth limit exceeded',node);
      rect(node.bounds,node);finite(node.opacity,'opacity',node);
      if (node.opacity<0||node.opacity>1) fail('opacity out of range',node);
      paintActive=paintActive&&node.style?.display!=='none'&&node.opacity>0;
      layoutActive=layoutActive&&node.style?.display!=='none';
      if(paintActive&&node.opacity<1) {
        opacityDepth++;stats.opacityGroups++;
        stats.maxOpacityDepth=Math.max(stats.maxOpacityDepth,opacityDepth);
        // A conservative RGBA backing estimate, not a driver memory promise.
        const bytes=this.canvas.width*this.canvas.height*4*opacityDepth;
        if(opacityDepth>32||!Number.isSafeInteger(bytes)||bytes>64*1024*1024)
          fail('opacity compositing backing/depth budget exceeded',node);
        stats.opacityBackingBytes=Math.max(stats.opacityBackingBytes,bytes);
      }
      if (!Array.isArray(node.children)) fail('node children must be an array',node);
      validateStackingMetadata(node);
      if(node.style?.flow!=null&&!record(node.style.flow))fail('invalid typed flow metadata',node);
      if(node.style?.flow!=null) {
        const flow=node.style.flow;
        if(Object.hasOwn(flow,'context')&&!['block','flex'].includes(flow.context))fail('invalid typed flow context',node);
        if(Object.hasOwn(flow,'order')&&(!Number.isInteger(flow.order)||flow.order< -2147483648||flow.order>2147483647))fail('invalid typed flow order: expected i32 integer',node);
      }
      if(node.style?.position!=null&&!['static','relative','absolute','fixed'].includes(node.style.position))fail('invalid positioning mode',node);
      if(viewportFixed(node)&&transformedAncestor)unsupported('fixed positioning inside a transformed containing block is unavailable',node);
      if(node.style?.box_sizing!==undefined&&!['border-box','content-box'].includes(node.style.box_sizing))fail('invalid box sizing',node);
      if(node.style?.display!=null&&!['none','flex'].includes(node.style.display))unsupported('unknown resolved display mode',node);
      if(Object.hasOwn(node,'visibility')&&!['visible','hidden'].includes(node.visibility))unsupported('unknown resolved visibility',node);
      if(node.text!=null&&typeof node.text!=='string')fail('invalid text',node);
      if(node.z_index!=null&&!Number.isInteger(node.z_index))fail('invalid z-index',node);
      if(node.computed_style!=null&&!record(node.computed_style))fail('invalid computed style',node);
      for(const value of Object.values(node.computed_style??{}))if(typeof value!=='string')fail('computed style values must be strings',node);
      if (['map','web-view'].includes(node.tag)
          || node.tag==='canvas'&&node.image!=null&&!ownedCanvasImage(node.image,images))
        unsupported(`${node.tag} drawing/resource contract is unavailable`,node);
      if(['camera','video','live-player','live-pusher'].includes(node.tag) && node.image != null && !node.image.resource?.startsWith('weapp-native-component-frame:')) fail('native media requires an owner-validated RGBA frame resource',node);
      if(node.image!=null) {
        if(!record(node.image)||!imageId(node.image.resource)||!Object.hasOwn(images,node.image.resource))fail('invalid or missing image resource reference',node);
        if(!imageModes.has(node.image.mode))fail('invalid image mode',node);
        stats.imageNodes++;
      } else if(node.tag==='image'&&node.attributes?.src)unsupported('image src requires the typed image resource contract',node);
      overflow(node);
      const translation=scrollTranslation(node);
      if(node.background!=null)validateColor(node.background,node);
      if(node.foreground!=null)validateColor(node.foreground,node);
      const geometry=boxGeometry(node),typography=layoutActive?validateTextLayout(node,stats,geometry.content,this.fontIdentity):textStyle(node);
      const spatialParent=viewportFixed(node)?identity:cssPaintPlan&&node.style?.position==='absolute'?absoluteParentMatrix:parentMatrix;
      const matrix=multiply(spatialParent,localMatrix(node),node);
      // A singular zero-area subtree is legal. Other matrices must retain a
      // finite f32 inverse before recording, even without an overflow clip.
      if(finite(determinant(matrix),'transform determinant',node)!==0)inverse(matrix,node);
      descendantClip(node,frame.viewport,matrix);
      for (const [property,value] of Object.entries(node.computed_style??{})) {
        if(layoutActive&&['white-space','word-break','text-align'].includes(property)&&!typography.flow)
          unsupported(`${property} requires the resolved text-flow contract`,node);
        if(property==='direction'&&value!=='ltr'||property==='unicode-bidi'&&value!=='normal')
          unsupported(`${property}:${value} requires bidirectional text layout`,node);
        if (['font-size','font-weight','font-family','line-height','font-style'].includes(property)
          &&!(typography.resolved&&['font-size','line-height'].includes(property))) {
          if (this.options.typography==='strict-css') unsupported(`Rust layout currently uses native-v1 typography; ${property}:${value} cannot be honored`,node);
          stats.semanticGaps.push({nodeId:node.id,property,requested:value,actual:typography.resolved?'resolved size/line height with supplied font':'legacy fixed 16px supplied font'});
        }
        if((property==='border'||property.startsWith('border-'))&&!property.includes('radius')) {
          const admitted=/^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/.test(property);
          if(!admitted)unsupported(`${property} painting is unavailable`,node);
        }
        if ((property==='background-image'||property==='box-shadow')&&value!=='none'
          ||property==='background'&&/(?:url|gradient)\(/i.test(value)
          ||['filter','backdrop-filter','text-shadow'].includes(property)&&value!=='none'
          ||property==='mix-blend-mode'&&value!=='normal'
          ||property==='visibility'&&value!==(node.visibility??'visible')) unsupported(`${property} painting is unavailable`,node);
      }
      validateUntypedBorders(node);
      if (node.text&&layoutActive) {
        const characters=node.text_layout?.flow!=null||this.fontIdentity?node.text_layout.glyphs.map(glyph=>glyph.character).filter(character=>!invisibleFlowCharacter(character)).join(''):node.text.replace(/[\r\n\t]/g,'');
        const glyphs=this.font.getGlyphIDs(characters);
        if (Array.from(glyphs).some(g=>g===0)) unsupported('font does not cover every requested character',node);
        stats.textNodes++;stats.glyphs+=glyphs.length;
        const measurement=record(node.text_layout?.measurement)?'font':node.text_layout?.measurement??(typography.resolved?'local':'legacy');
        stats.textPlans[measurement]=(stats.textPlans[measurement]??0)+1;
      }
      const descendantMatrix=multiply(matrix,translation,node);
      const containing=depth===0||(node.style?.position??'static')!=='static'||node.style?.transform!=null;
      const absoluteMatrix=containing?descendantMatrix:absoluteParentMatrix;
      node.children.forEach(child=>visit(child,depth+1,descendantMatrix,absoluteMatrix,transformedAncestor||node.style?.transform!=null,opacityDepth,paintActive,layoutActive));
      if(node.text!=null&&node.children.some(child=>siblingOrder(node,child)!==0))
        unsupported('flex order beside anonymous parent text requires an explicit text leaf',node);
    };
    visit(frame.root,0,identity,identity,false,0,true,true);
    stats.paintOrder=this.preflightPaintPlan(frame);
    return stats;
  }
  preflightPaintPlan(frame) {
    if(Object.hasOwn(frame,'paintPlan')) {
      const entries=validatePaintPlan(frame);
      return {contract:'committed-paint-plan-v1',commands:entries.length};
    }
    legacyStackingBoundary(frame.root);
    return {contract:'legacy-recursive-v1',cssStackingOracle:false};
  }
  submit(frame) {
    const CK=this.CK;
    // Invalid/unsupported frames and picture-recording errors never touch the
    // onscreen canvas. Driver failures during submission cannot promise rollback.
    let recorder=null,picture=null,prepared=null;
    try {
      const stats=this.validate(frame);
      prepared=this.prepareImages(frame);
      recorder=new CK.PictureRecorder();
      const target=recorder.beginRecording([0,0,frame.viewport.width,frame.viewport.height]);
      this.drawFrame(target,frame,stats,prepared.images);
      picture=recorder.finishRecordingAsPicture();
      if(!picture)fail('CanvasKit picture recording failed');
      const canvas=this.surface.getCanvas();canvas.clear(CK.TRANSPARENT);canvas.save();
      try {
        canvas.scale(this.canvas.width/frame.viewport.width,this.canvas.height/frame.viewport.height);
        canvas.drawPicture(picture);
      } finally {canvas.restore();}
      // Submission does not wait for GPU completion. Explicit evidence
      // readback synchronizes separately; the normal frame path stays async.
      this.surface.flush();
      const glError=this.gl.getError();
      if (glError!==this.gl.NO_ERROR) fail(`WebGL submission failed with 0x${glError.toString(16)}`);
      const receipt={
        schemaVersion:1,backend:'canvaskit-webgl2',status:'submitted',frameId:frame.frame_id,generation:this.generation+1,
        viewport:{...frame.viewport},physicalSize:[this.canvas.width,this.canvas.height],context:this.contextInfo(),
        runtimeBoundary:{frameBatches:1,perNodeRuntimeCalls:0,softwareRgbaUploads:0},
        presentation:{pictureSubmissions:1,flushes:1,gpuCompletion:'not-waited',glError},
        ...stats,typography:'resolved-text-v1; legacy frames retain native-v1',parityStatus:'partial',
        limits:['CanvasKit WebGL submission is not physical-device evidence.','No official DevTools visual diff.',
          'Committed glyph positions are replayed without reflow. Supplied font glyph shapes/weight can differ from native hosts.',
          'Frames without a text layout use local supplied-face metrics; their geometry is not a cross-host typography proof.',
          'Exactly singular transforms have no pixel area; unrepresentable transform inverses fail before recording.',
          'Images replay committed RGBA8 resources with nearest sampling; asset decoding belongs to the runtime.',
          'Non-solid border styles and shadows fail explicitly.',
          'Scroll containers consume resolved offsets; gesture, inertia and clamping belong to the runtime.'],
      };
      // Pictures retain their own SkImage references while queued on the GPU.
      // Release temporary owners before changing the persistent cache; a
      // recording/temporary-cleanup failure cannot evict accepted resources.
      const temporary=[picture,recorder];picture=null;recorder=null;release(...temporary);
      receipt.imageCache=this.commitImages(prepared);
      this.generation=receipt.generation;this.lastReceipt=receipt;return receipt;
    } catch(error){throw renderError(error);}
    finally {release(picture,recorder,...(prepared?.created??[]).map(entry=>entry.image));}
  }
  prepareImages(frame) {
    const prepared={images:new Map(),entries:new Map(),created:[],hits:0};
    try {
      for(const [id,resource] of Object.entries(frame.images??{})) {
        let entry=this.imageCache.get(id);
        if(sameImage(entry,resource))prepared.hits++;
        else {
          // A resource name (including a sha256-looking name) is not proof of
          // decoded pixels. Retain an independent byte copy so caller mutation
          // cannot make an old SkImage appear to contain new pixels.
          const pixels=Uint8Array.from(resource.pixels),image=this.makeImage(resource,pixels);
          entry={width:resource.width,height:resource.height,pixels,image,bytes:pixels.byteLength*2};
          prepared.created.push(entry);
        }
        prepared.images.set(id,entry.image);prepared.entries.set(id,entry);
      }
      return prepared;
    } catch(error) {release(...prepared.created.map(entry=>entry.image));throw renderError(error);}
  }
  commitImages(prepared) {
    const next=new Map(this.imageCache);
    for(const [id,entry] of prepared.entries) {
      next.delete(id);
      if(entry.bytes<=this.imageCacheBudget)next.set(id,entry);
    }
    let bytes=[...next.values()].reduce((sum,entry)=>sum+entry.bytes,0);
    for(const [id,entry] of next) {
      if(bytes<=this.imageCacheBudget&&next.size<=maxImageCacheEntries)break;
      next.delete(id);bytes-=entry.bytes;
    }
    const retained=new Set(next.values());
    const retired=[...new Set([...this.imageCache.values(),...prepared.created])].filter(entry=>!retained.has(entry));
    const misses=prepared.created.length;
    this.imageCache=next;this.imageCacheBytes=bytes;
    // Ownership has moved to either the cache or this retirement list before
    // deletion, so a failing destructor is reported without a double delete.
    prepared.created=[];
    release(...retired.map(entry=>entry.image));
    return {hits:prepared.hits,misses,entries:next.size,accountedBytes:bytes,budgetBytes:this.imageCacheBudget,
      accounting:'owned-rgba-copy-plus-rgba-image-estimate'};
  }
  clearImageCache() {
    const entries=[...this.imageCache.values()];this.imageCache.clear();this.imageCacheBytes=0;
    release(...entries.map(entry=>entry.image));
  }
  makeImage(resource,pixels) {
    const CK=this.CK;
    const image=CK.MakeImage({width:resource.width,height:resource.height,colorType:CK.ColorType.RGBA_8888,
      alphaType:CK.AlphaType.Unpremul,colorSpace:CK.ColorSpace.SRGB},pixels,resource.width*4);
    if(!image)fail('CanvasKit image resource creation failed');
    return image;
  }
  createImages(frame) {
    // Explicit uncached helper for offline replay. Its caller owns every
    // returned SkImage; submit uses the transactional cache above instead.
    const images=new Map();
    try {
      for(const [id,resource] of Object.entries(frame.images??{})) {
        images.set(id,this.makeImage(resource,Uint8Array.from(resource.pixels)));
      }
      return images;
    } catch(error) {release(...images.values());throw renderError(error);}
  }
  drawFrame(canvas,frame,stats,images=new Map()) {
    if(!Object.hasOwn(frame,'paintPlan')) {
      legacyStackingBoundary(frame.root);
      return this.drawNode(canvas,frame.root,{red:0,green:0,blue:0,alpha:255},stats,
        {viewport:frame.viewport,matrix:identity,images});
    }
    // Preflight the complete order/space contract before the first save,
    // layer or draw. Only opacity from the validated node can create a layer.
    const entries=validatePaintPlan(frame),groups=[];
    try {
      for(const {op,space} of entries) {
        const {node}=space;
        if(op==='begin') {
          const group={paint:null,saved:false};groups.push(group);
          if(space.active&&node.opacity<1) {
            group.paint=new this.CK.Paint();
            group.paint.setAlphaf(opacityAlpha(node.opacity)/255);
            canvas.saveLayer(group.paint);group.saved=true;
          }
        } else if(op==='end') {
          const group=groups.pop();
          try {if(group.saved)canvas.restore();} finally {release(group.paint);}
        } else if(space.active) {
          canvas.save();
          try {
            for(const clip of space.clips) {
              canvas.concat(clip.matrix);
              if(clip.radii?.some(value=>value>0))canvas.clipRRect([...clip.bounds,...clip.radii],this.CK.ClipOp.Intersect,false);
              else canvas.clipRect(clip.bounds,this.CK.ClipOp.Intersect,false);
              canvas.concat(inverse(clip.matrix,node));
            }
            canvas.concat(space.matrix);
            this.drawNodePaint(canvas,node,space.foreground,stats,images,op);
          } finally {canvas.restore();}
        }
      }
    } finally {
      // Recording failures unwind every owned active layer before releasing
      // paints; the caller still discards this entire unsubmitted picture.
      const errors=[];
      for(const group of groups.reverse()) {
        try {if(group.saved)canvas.restore();} catch(error) {errors.push(error);}
        try {release(group.paint);} catch(error) {errors.push(error);}
      }
      if(errors.length)fail('paintPlan layer cleanup failed: '+errors.map(error=>error.message??String(error)).join('; '));
    }
  }
  drawNode(canvas,node,inheritedForeground,stats,paintSpace={viewport:{x:0,y:0,width:this.canvas.width,height:this.canvas.height},matrix:identity}) {
    if(newStackingMetadata(node))unsupported('typed stacking metadata requires drawFrame and a committed paintPlan',node);
    if (node.style?.display==='none'||node.opacity===0) return;
    const CK=this.CK,foreground=node.foreground??inheritedForeground;
    const fixed=viewportFixed(node);
    if(fixed&&paintSpace.transformedAncestor)unsupported('fixed positioning inside a transformed containing block is unavailable',node);
    const local=localMatrix(node),matrix=multiply(fixed?identity:paintSpace.matrix,local,node);
    const clips=fixed?[]:(paintSpace.clips??[]);
    if(!invertible(matrix))return;
    // Opacity composites this entire subtree once. Keep the layer outside
    // node-local transforms/clips so overflowing and viewport-fixed children
    // can escape their ancestor geometry while still belonging to this group.
    let groupPaint=null,groupSaved=false;
    try {
      if(node.opacity<1) {
        groupPaint=new CK.Paint();
        groupPaint.setAlphaf(opacityAlpha(node.opacity)/255);
        canvas.saveLayer(groupPaint);
        groupSaved=true;
      }
      canvas.save();
      try {
        // Each node starts at the caller's target scale. World-space clip
        // descriptors preserve rounded/transformed clips for ordinary children;
        // fixed subtrees can discard ancestor overflow without changing order.
        for(const clip of clips) {
          canvas.concat(clip.matrix);
          if(clip.radii?.some(value=>value>0))canvas.clipRRect([...clip.bounds,...clip.radii],CK.ClipOp.Intersect,false);
          else canvas.clipRect(clip.bounds,CK.ClipOp.Intersect,false);
          canvas.concat(inverse(clip.matrix,node));
        }
        canvas.concat(matrix);
        if(node.visibility!=='hidden')this.drawNodePaint(canvas,node,foreground,stats,paintSpace.images);
      } finally {canvas.restore();}
      const clip=descendantClip(node,paintSpace.viewport,matrix);
      const childClips=clip?[...clips,{...clip,matrix}]:clips;
      const descendantMatrix=multiply(matrix,scrollTranslation(node),node);
      const ordered=node.children.map((child,index)=>({child,index,order:siblingOrder(node,child)}))
        .sort((a,b)=>(a.child.z_index??0)-(b.child.z_index??0)||a.order-b.order||a.index-b.index);
      ordered.forEach(({child})=>this.drawNode(canvas,child,foreground,stats,{viewport:paintSpace.viewport,matrix:descendantMatrix,
        clips:childClips,images:paintSpace.images,transformedAncestor:paintSpace.transformedAncestor||node.style?.transform!=null}));
    } finally {
      try {if(groupSaved)canvas.restore();} finally {release(groupPaint);}
    }
  }
  drawNodePaint(canvas,node,foreground,stats,images,phase='all') {
    const CK=this.CK,geometry=boxGeometry(node);
    if(phase!=='content') {
      if (node.background) {
        const paint=new CK.Paint();
        try {
          paint.setAntiAlias(true);paint.setColor(color(CK,node.background,1,node));
          const r=radii(node),bounds=rect(node.bounds,node);
          if(r.some(v=>v>0)) canvas.drawRRect([...bounds,...r],paint);else canvas.drawRect(bounds,paint);
          stats.drawCommands++;
        } finally {paint.delete();}
      }
      this.drawBorders(canvas,node,geometry,1,stats);
    }
    if(phase==='background')return;
    const content=geometry.content;
    if(node.image) {
      const image=images?.get(node.image.resource);
      if(!image)fail('CanvasKit image resource was not prepared',node);
      const placement=imageGeometry({width:image.width(),height:image.height()},node.image.mode,content);
      if(placement) {
        const paint=new CK.Paint();canvas.save();
        try {
          paint.setAntiAlias(false);paint.setAlphaf(1);
          if(geometry.outerRadii.some(value=>value>0))canvas.clipRRect([...geometry.outer,...geometry.outerRadii],CK.ClipOp.Intersect,false);
          canvas.clipRect(rect(content,node),CK.ClipOp.Intersect,false);
          canvas.drawImageRectOptions(image,placement.source,placement.destination,CK.FilterMode.Nearest,CK.MipmapMode.None,paint);
          stats.drawCommands++;
        } finally {canvas.restore();paint.delete();}
      }
    }
    const typography=textStyle(node),resolvedText=typography.resolved||node.text_layout!=null;
    if (node.text && typography.fontSize>0 && (resolvedText||content.width>0&&content.height>0)) {
      const paint=new CK.Paint();canvas.save();
      try {
        paint.setColor(color(CK,foreground,1,node));paint.setAntiAlias(true);
        this.font.setSize(typography.fontSize);
        // Typed text's ink may overflow its line box (including a zero
        // line-height). Only ancestor overflow clips constrain it. Legacy
        // manually positioned frames retain their original own-box clip.
        if(!resolvedText)canvas.clipRect(rect(content,node),CK.ClipOp.Intersect,false);
        if(node.text_layout) {
          // The same plan drove Rust layout, hit geometry and selector
          // queries. A host must not remeasure or wrap an accepted frame.
          const characters=[],positions=[];
          for(const glyph of node.text_layout.glyphs) {
            if((node.text_layout.flow!=null||this.fontIdentity)&&invisibleFlowCharacter(glyph.character))continue;
            characters.push(glyph.character);
            // Preserve each original absolute coordinate before its float32
            // conversion. A shared nonzero origin would round differently.
            positions.push(content.x+glyph.x,content.y+glyph.baseline_y);
          }
          if(characters.length) {
            const ids=this.font.getGlyphIDs(characters.join(''),characters.length);
            if(!ids||ids.length!==characters.length)fail('font glyph mapping differs from the committed scalar count',node);
            canvas.drawGlyphs(ids,positions,0,0,this.font,paint);
            stats.drawCommands++;
          }
        } else {
          // Old absolute frames preserve native-v1 placement. New typed
          // frames without a plan are an explicit local-metrics fallback.
          let x=0,baseline=typography.fontSize;
          for(const ch of node.text) {
            if(ch==='\r')continue;
            if(ch==='\n'){x=0;baseline+=typography.lineHeight;continue;}
            const glyph=ch==='\t'?null:this.font.getGlyphIDs(ch);
            const advance=ch==='\t'?typography.fontSize*2:this.font.getGlyphWidths(glyph,paint)[0];
            if(typography.resolved&&content.width>0&&x>0&&x+advance>content.width){x=0;baseline+=typography.lineHeight;}
            if(glyph){canvas.drawGlyphs(glyph,[0,0],content.x+x,content.y+baseline,this.font,paint);stats.drawCommands++;}
            x+=advance;
          }
        }
      } finally {canvas.restore();paint.delete();}
    }
  }
  drawBorders(canvas,node,geometry,opacity,stats) {
    const CK=this.CK,{sides,outer,outerRadii,inner,innerRadii,widths}=geometry;
    if(!widths.some(width=>width>0))return;
    canvas.save();
    try {
      // Paint an outer-minus-inner ring over the existing background. Never
      // erase the hole: transparent borders must retain all pixels beneath it.
      if(outerRadii.some(value=>value>0))canvas.clipRRect([...outer,...outerRadii],CK.ClipOp.Intersect,false);
      else canvas.clipRect(outer,CK.ClipOp.Intersect,false);
      if(inner[2]>inner[0]&&inner[3]>inner[1]) {
        if(innerRadii.some(value=>value>0))canvas.clipRRect([...inner,...innerRadii],CK.ClipOp.Difference,false);
        else canvas.clipRect(inner,CK.ClipOp.Difference,false);
      }
      for(let index=0;index<4;index++) {
        if(widths[index]===0||sides[index].color.alpha===0)continue;
        const points=borderPolygon(geometry,index);
        if(points.length<3)continue;
        let path=null,paint=null;
        try {
          // These weighted edge regions partition the ring without overlapping
          // strokes. Shared corners blend once, including alpha.
          path=CK.Path.MakeFromCmds([CK.MOVE_VERB,...points[0],...points.slice(1).flatMap(point=>[CK.LINE_VERB,...point]),CK.CLOSE_VERB]);
          if(!path)fail('border path creation failed',node);
          paint=new CK.Paint();paint.setAntiAlias(false);paint.setColor(color(CK,sides[index].color,opacity,node));
          canvas.drawPath(path,paint);stats.drawCommands++;
        } finally {release(paint,path);}
      }
    } finally {canvas.restore();}
  }
  snapshotEvidence() {
    this.assertAvailable();
    if(!this.lastReceipt)fail('cannot read back before a submitted frame');
    const CK=this.CK;let image=null;
    try {
      this.gl.finish();
      const glError=this.gl.getError();
      if(glError!==this.gl.NO_ERROR)fail(`WebGL evidence synchronization failed with 0x${glError.toString(16)}`);
      image=this.surface.makeImageSnapshot();
      if(!image)fail('CanvasKit GPU image snapshot failed');
      const pixels=image.readPixels(0,0,{width:this.canvas.width,height:this.canvas.height,colorType:CK.ColorType.RGBA_8888,alphaType:CK.AlphaType.Unpremul,colorSpace:CK.ColorSpace.SRGB});
      if(!pixels||pixels.length!==this.canvas.width*this.canvas.height*4)fail('CanvasKit GPU image readback failed');
      const sample=(x,y)=>({x,y,rgba:Array.from(pixels.slice((y*this.canvas.width+x)*4,(y*this.canvas.width+x)*4+4))});
      return {frameId:this.lastReceipt.frameId,source:'CanvasKit GPU surface readback',gpuCompletion:'gl.finish',samples:[sample(0,0),sample(this.canvas.width-1,0),sample(0,this.canvas.height-1),sample(this.canvas.width-1,this.canvas.height-1)],rgba:pixels};
    } catch(error){throw renderError(error);}
    finally {image?.delete();}
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    const errors=this.resourceCleanupErrors.splice(0),cleanup=action=>{try{action();}catch(error){errors.push(error.message??String(error));}};
    cleanup(()=>this.canvas.removeEventListener('webglcontextlost',this.onLost));
    cleanup(()=>this.clearImageCache());
    for(const key of ['font','typeface','surface','context']) {
      const resource=this[key];this[key]=null;
      if(resource)cleanup(()=>resource.delete());
    }
    const handle=this.contextHandle;this.contextHandle=0;
    if(handle>0)cleanup(()=>this.CK.deleteContext(handle));
    if(errors.length)fail(`CanvasKit cleanup failed: ${errors.join('; ')}`);
  }
}
