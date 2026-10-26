export type GestureKind='pinch'|'rotate'|'double_tap'|'two_finger_swipe'
export interface GestureOptions{kind:GestureKind;center_x?:number;center_y?:number;radius_px?:number;scale?:number;angle_degrees?:number;dx?:number;dy?:number;x?:number;y?:number;duration_ms?:number;gap_ms?:number}
export interface GestureFrame {at_ms:number;points:{x:number;y:number}[]}
/** Validate every point before producing a single input event. Coordinates are original screenshot pixels. */
export function planGesture(options:GestureOptions,width:number,height:number):GestureFrame[]{
  const finite=(value:unknown,name:string)=>{if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`手势需要有效的 ${name}`);return value}
  const point=(x:number,y:number)=>{if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=width||y>=height)throw new Error('手势路径超出截图范围，请调整中心、半径或移动距离');return{x,y}}
  const allowed:Record<GestureKind,string[]>={double_tap:['kind','x','y','gap_ms'],pinch:['kind','center_x','center_y','radius_px','scale','duration_ms'],rotate:['kind','center_x','center_y','radius_px','angle_degrees','duration_ms'],two_finger_swipe:['kind','center_x','center_y','radius_px','dx','dy','duration_ms']}
  if(!Object.hasOwn(allowed,options.kind))throw new Error('不支持的手势类型')
  if(Object.entries(options).some(([key,value])=>value!==undefined&&!allowed[options.kind].includes(key)))throw new Error('手势包含不适用于该类型的参数')
  if(options.kind==='double_tap'){
    const p=point(finite(options.x,'x'),finite(options.y,'y')),gap=options.gap_ms??120
    if(!Number.isInteger(gap)||gap<60||gap>250)throw new Error('双击间隔须为 60–250 ms')
    return[{at_ms:0,points:[p]},{at_ms:50,points:[]},{at_ms:50+gap,points:[p]},{at_ms:100+gap,points:[]}]
  }
  const cx=finite(options.center_x,'center_x'),cy=finite(options.center_y,'center_y'),radius=options.radius_px??Math.min(width,height)*0.12,duration=options.duration_ms??600
  if(!Number.isFinite(radius)||radius<8||radius>Math.min(width,height)/2)throw new Error('手势半径须为 8 像素到截图短边的一半')
  if(!Number.isInteger(duration)||duration<200||duration>3000)throw new Error('手势时长须为 200–3000 ms')
  const scale=options.kind==='pinch'?finite(options.scale,'scale'):1,angle=options.kind==='rotate'?finite(options.angle_degrees,'angle_degrees'):0,dx=options.kind==='two_finger_swipe'?finite(options.dx,'dx'):0,dy=options.kind==='two_finger_swipe'?finite(options.dy,'dy'):0
  if(scale<0.25||scale>4||scale===1&&options.kind==='pinch')throw new Error('缩放倍率须为 0.25–4，且不能为 1')
  if(options.kind==='rotate'&&(Math.abs(angle)<1||Math.abs(angle)>180))throw new Error('旋转角度绝对值须为 1–180 度')
  if(options.kind==='two_finger_swipe'&&dx===0&&dy===0)throw new Error('双指移动距离不能都为 0')
  const count=Math.ceil(duration/30),frames:GestureFrame[]=[]
  for(let i=0;i<=count;i++){const t=i/count,r=radius*(1+(scale-1)*t),a=angle*Math.PI/180*t,x=r*Math.cos(a),y=r*Math.sin(a);frames.push({at_ms:Math.round(duration*t),points:[point(cx+dx*t-x,cy+dy*t-y),point(cx+dx*t+x,cy+dy*t+y)]})}
  frames.push({at_ms:duration,points:[]});return frames
}
