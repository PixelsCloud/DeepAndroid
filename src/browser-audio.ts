/** Bounded PCM playback. AudioContext is created only from the user's explicit playback gesture. */
export class PhoneAudio{
 private context?:AudioContext;private gain?:GainNode;private next=0;private volume=1;private sources=new Set<AudioBufferSourceNode>();enabled=false;packets=0;dropped=0
 async enable(value:boolean){this.enabled=value;if(!value){this.reset();return}this.context??=new AudioContext({sampleRate:48000,latencyHint:'interactive'});if(!this.gain){this.gain=this.context.createGain();this.gain.gain.value=this.volume;this.gain.connect(this.context.destination)}await this.context.resume()}
 setVolume(value:number){if(!Number.isFinite(value)||value<0||value>1)throw new Error('播放音量无效');this.volume=value;if(this.gain)this.gain.gain.value=value}
 push(data:ArrayBuffer){if(data.byteLength<14||data.byteLength>1024**2||(data.byteLength-10)%4!==0)throw new Error('PCM 音频包无效');this.packets++;const ctx=this.context;if(!this.enabled||!ctx||ctx.state!=='running')return;const frames=(data.byteLength-10)/4,view=new DataView(data,10),buffer=ctx.createBuffer(2,frames,48000);for(let channel=0;channel<2;channel++){const samples=buffer.getChannelData(channel);for(let i=0;i<frames;i++)samples[i]=view.getInt16(i*4+channel*2,true)/32768}if(this.next>ctx.currentTime+0.3){this.dropped++;return}const source=ctx.createBufferSource();source.buffer=buffer;source.connect(this.gain!);source.onended=()=>{this.sources.delete(source);source.disconnect()};this.sources.add(source);this.next=Math.max(ctx.currentTime+0.015,this.next);source.start(this.next);this.next+=frames/48000}
 reset(){for(const source of this.sources){try{source.stop()}catch{}}this.sources.clear();this.next=0}
 dispose(){this.reset();void this.context?.close()}
}
