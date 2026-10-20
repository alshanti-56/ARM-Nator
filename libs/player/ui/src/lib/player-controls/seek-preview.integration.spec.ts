import { TestBed } from '@angular/core/testing';
import { SeekPreviewComponent } from './seek-preview.component';
import { rememberSeekFrame, cachedSeekFrame } from './seek-frame-cache';

function fixture(){
 const fixture=TestBed.createComponent(SeekPreviewComponent);
 fixture.componentRef.setInput('duration',100);fixture.componentRef.setInput('cacheKey','fixture');fixture.detectChanges();
 const input=document.createElement('input');input.type='range';input.max='100';input.value='25';
 input.getBoundingClientRect=()=>({left:10,width:100,right:110,top:0,bottom:10,height:10,x:10,y:0,toJSON:()=>({})});
 fixture.nativeElement.append(input);
 return {fixture,input,component:fixture.componentInstance};
}
afterEach(()=>{TestBed.resetTestingModule();jest.restoreAllMocks();});
it('hover shows the requested time without seeking or emitting a progress change',()=>{
 const h=fixture(),change=jest.fn(),input=jest.fn();h.input.addEventListener('change',change);h.input.addEventListener('input',input);
 h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:85,bubbles:true}));h.fixture.detectChanges();
 expect(h.fixture.nativeElement.querySelector('.seek-preview span').textContent).toContain('1:15');expect(h.input.value).toBe('25');expect(change).not.toHaveBeenCalled();expect(input).not.toHaveBeenCalled();
 h.input.dispatchEvent(new MouseEvent('pointerleave',{bubbles:true}));h.fixture.detectChanges();expect(h.fixture.nativeElement.querySelector('.seek-preview')).toBeNull();
});
it('uses supplied sprite cues, and failed images fall back to time rather than a broken thumbnail',()=>{
 const h=fixture();h.fixture.componentRef.setInput('source',{cues:[{start:0,end:100,url:'https://fixture/sprite.jpg',crop:{x:160,y:0,width:160,height:90}}]});h.fixture.detectChanges();
 h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:60,bubbles:true}));h.fixture.detectChanges();
 const image=h.fixture.nativeElement.querySelector('img') as HTMLImageElement;
 Object.defineProperties(image,{naturalWidth:{value:320},naturalHeight:{value:90}});image.dispatchEvent(new Event('load'));h.fixture.detectChanges();
 expect(image.style.width).toBe('320px');expect(image.style.transform).toBe('translate(-160px, 0px)');
 image.dispatchEvent(new Event('error'));h.fixture.detectChanges();expect(h.fixture.nativeElement.querySelector('img')).toBeNull();expect(h.fixture.nativeElement.querySelector('.seek-preview span').textContent).toContain('0:50');
});
it('dragging or keyboard input previews the value and disabled/live controls hide it',()=>{
 const h=fixture();h.input.value='80';h.input.dispatchEvent(new Event('input',{bubbles:true}));h.fixture.detectChanges();expect(h.component.seconds()?.value).toBe(80);
 h.fixture.componentRef.setInput('enabled',false);h.fixture.detectChanges();expect(h.fixture.nativeElement.querySelector('.seek-preview')).toBeNull();
});
it('cached decoded frames remain bounded and unavailable positions have no invented image',()=>{
 for(let i=0;i<121;i++)rememberSeekFrame('cache-limit',i*30,'data:image/jpeg;base64,AAAA');
 expect(cachedSeekFrame('cache-limit',0)).toBeNull();expect(cachedSeekFrame('cache-limit',3600)?.url).toContain('image/jpeg');expect(cachedSeekFrame('cache-limit',99999)).toBeNull();
});
it('video URLs are never fetched as preview metadata',()=>{
 const h=fixture(),fetch=jest.fn();const old=globalThis.fetch;globalThis.fetch=fetch;
 try{h.fixture.componentRef.setInput('source',{vttUrl:'https://fixture/movie.mp4'});h.fixture.detectChanges();h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:60,bubbles:true}));expect(fetch).not.toHaveBeenCalled();}finally{globalThis.fetch=old;}
});
it('captures only an already decoded active-video frame, with no source fetch or seek',()=>{
 const h=fixture(),surface=document.createElement('div'),video=document.createElement('video');surface.append(video);
 Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080},readyState:{value:2},seeking:{value:false},currentTime:{value:35,writable:true}});
 const hidden=Object.getOwnPropertyDescriptor(document,'hidden');Object.defineProperty(document,'hidden',{configurable:true,value:false});
 const drawImage=jest.fn();jest.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D);jest.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');
 const old=globalThis.fetch,fetch=jest.fn();globalThis.fetch=fetch;
 try{h.fixture.componentRef.setInput('cacheKey','decoded-frame');h.fixture.componentRef.setInput('videoSurface',surface);h.fixture.detectChanges();video.dispatchEvent(new Event('timeupdate'));h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:45,bubbles:true}));h.fixture.detectChanges();expect(h.component.frame()?.url).toBe('data:image/jpeg;base64,AAAA');expect(drawImage).toHaveBeenCalledTimes(1);expect(video.currentTime).toBe(35);expect(fetch).not.toHaveBeenCalled();}finally{globalThis.fetch=old;if(hidden)Object.defineProperty(document,'hidden',hidden);else delete (document as unknown as Record<string,unknown>)['hidden'];}
});
it('a late VTT response cannot attach images after the playback source changes',async()=>{
 const h=fixture();let resolve!:(value:unknown)=>void;
 const old=globalThis.fetch,fetch=jest.fn().mockReturnValue(new Promise(r=>resolve=r));globalThis.fetch=fetch;
 try{h.fixture.componentRef.setInput('source',{vttUrl:'https://fixture/first.vtt'});h.fixture.detectChanges();h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:45,bubbles:true}));expect(fetch).toHaveBeenCalledTimes(1);
 const options=fetch.mock.calls[0][1];h.fixture.componentRef.setInput('source',undefined);h.fixture.detectChanges();expect(options.signal.aborted).toBe(true);
 resolve({ok:true,headers:{get:()=>null},body:null});await Promise.resolve();await Promise.resolve();h.fixture.detectChanges();expect(h.component.frame()).toBeNull();expect(h.component.seconds()).toBeNull();}finally{globalThis.fetch=old;}
});

it('anchors native previews inside the reserved dock for pointer and keyboard input',()=>{
 const h=fixture(),dock=document.createElement('div');
 dock.getBoundingClientRect=()=>({top:180} as DOMRect);
 h.fixture.nativeElement.getBoundingClientRect=()=>({top:200} as DOMRect);
 h.fixture.componentRef.setInput('dock',true);h.fixture.componentRef.setInput('dockSurface',dock);h.fixture.detectChanges();
 h.input.dispatchEvent(new MouseEvent('pointermove',{clientX:60,bubbles:true}));h.fixture.detectChanges();
 expect(h.fixture.nativeElement.querySelector('.seek-preview').style.top).toBe('-18px');
 dock.getBoundingClientRect=()=>({top:160} as DOMRect);
 h.input.dispatchEvent(new Event('input',{bubbles:true}));h.fixture.detectChanges();
 expect(h.fixture.nativeElement.querySelector('.seek-preview').style.top).toBe('-38px');
});

it('caches the displayed renderer frame when canvas export is blocked, without seeking or fetching',async()=>{
 const h=fixture(),surface=document.createElement('div'),video=document.createElement('video');surface.append(video);
 Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080},readyState:{value:4},seeking:{value:false},currentTime:{value:35,writable:true}});
 video.getBoundingClientRect=()=>({x:10,y:20,width:640,height:360,left:10,top:20,right:650,bottom:380} as DOMRect);
 const hidden=Object.getOwnPropertyDescriptor(document,'hidden'),bridge=Object.getOwnPropertyDescriptor(window,'electron');
 Object.defineProperty(document,'hidden',{configurable:true,value:false});
 const capture=jest.fn().mockResolvedValue('data:image/jpeg;base64,RENDERER');Object.defineProperty(window,'electron',{configurable:true,value:{captureWebVideoFrame:capture}});
 jest.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:jest.fn()} as unknown as CanvasRenderingContext2D);
 jest.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(()=>{throw new DOMException('Tainted canvas','SecurityError');});
 try{h.fixture.componentRef.setInput('cacheKey','tainted-frame');h.fixture.componentRef.setInput('videoSurface',surface);h.fixture.detectChanges();video.dispatchEvent(new Event('timeupdate'));await Promise.resolve();await Promise.resolve();h.fixture.detectChanges();
 expect(capture).toHaveBeenCalledWith({x:10,y:20,width:640,height:360});expect(cachedSeekFrame('tainted-frame',35)?.url).toContain('RENDERER');expect(video.currentTime).toBe(35);
 }finally{if(hidden)Object.defineProperty(document,'hidden',hidden);else delete (document as unknown as Record<string,unknown>)['hidden'];if(bridge)Object.defineProperty(window,'electron',bridge);else delete (window as unknown as Record<string,unknown>)['electron'];}
});

it('discards a delayed displayed-frame response after the playback identity changes',async()=>{
 const h=fixture(),surface=document.createElement('div'),video=document.createElement('video');surface.append(video);
 Object.defineProperties(video,{videoWidth:{value:1920},readyState:{value:4},seeking:{value:false},currentTime:{value:35,writable:true}});
 video.getBoundingClientRect=()=>({x:10,y:20,width:640,height:360} as DOMRect);
 const hidden=Object.getOwnPropertyDescriptor(document,'hidden'),bridge=Object.getOwnPropertyDescriptor(window,'electron');
 Object.defineProperty(document,'hidden',{configurable:true,value:false});let resolve!:(image:string)=>void;
 const capture=jest.fn().mockReturnValue(new Promise<string>(r=>resolve=r));Object.defineProperty(window,'electron',{configurable:true,value:{captureWebVideoFrame:capture}});
 jest.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:jest.fn()} as unknown as CanvasRenderingContext2D);
 jest.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(()=>{throw new DOMException('Tainted canvas','SecurityError');});
 try{h.fixture.componentRef.setInput('cacheKey','stale-tainted-frame');h.fixture.componentRef.setInput('videoSurface',surface);h.fixture.detectChanges();video.dispatchEvent(new Event('timeupdate'));expect(capture).toHaveBeenCalledTimes(1);
 h.fixture.componentRef.setInput('cacheKey','next-frame-source');h.fixture.detectChanges();resolve('data:image/jpeg;base64,STALE');await Promise.resolve();await Promise.resolve();
 expect(cachedSeekFrame('stale-tainted-frame',35)).toBeNull();expect(cachedSeekFrame('next-frame-source',35)).toBeNull();
 }finally{if(hidden)Object.defineProperty(document,'hidden',hidden);else delete (document as unknown as Record<string,unknown>)['hidden'];if(bridge)Object.defineProperty(window,'electron',bridge);else delete (window as unknown as Record<string,unknown>)['electron'];}
});
