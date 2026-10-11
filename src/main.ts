import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {createSLSModel} from './createSLSModel';
import './style.css';
const params=new URLSearchParams(location.search);const stage=Number(params.get('stage')??7);
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
document.querySelector('#viewport')!.append(renderer.domElement);
const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(32,innerWidth/innerHeight,.1,200);
camera.position.set(20,12,31);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,7,0);controls.enableDamping=true;controls.autoRotate=true;controls.autoRotateSpeed=.65;controls.minDistance=20;controls.maxDistance=65;controls.maxPolarAngle=Math.PI*.8;
scene.add(new THREE.AmbientLight(0xcad3ed,.7));const key=new THREE.DirectionalLight(0xfff0cf,2.6);key.position.set(-8,16,10);scene.add(key);const rim=new THREE.DirectionalLight(0x9fbbe6,.45);rim.position.set(5,10,-8);scene.add(rim);
const model=createSLSModel({stage});scene.add(model.root);
const shadow=new THREE.Mesh(new THREE.CircleGeometry(3.6,64),new THREE.MeshBasicMaterial({color:0xcbbfa6,transparent:true,opacity:.5,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=-.05;shadow.scale.y=.58;scene.add(shadow);
const orbit=new THREE.Mesh(new THREE.RingGeometry(4.15,4.18,96),new THREE.MeshBasicMaterial({color:0xc7b99f,side:THREE.DoubleSide}));orbit.rotation.x=-Math.PI/2;orbit.position.y=-.07;scene.add(orbit);
let explodeTarget=0,explode=0,fire=false,fireMix=0,viewScale=1;const clock=new THREE.Clock();
function size(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();if(innerWidth<900)camera.setViewOffset(innerWidth,innerHeight,-innerWidth*.1,0,innerWidth,innerHeight);else camera.clearViewOffset();}size();addEventListener('resize',size);
const bind=(id:string,cb:()=>void)=>document.querySelector<HTMLButtonElement>('#'+id)!.addEventListener('click',cb);
bind('spin',()=>{controls.autoRotate=!controls.autoRotate;document.querySelector('#spin')!.classList.toggle('active',controls.autoRotate);});
bind('explode',()=>{explodeTarget=explodeTarget?0:1;document.querySelector('#explode')!.classList.toggle('active',!!explodeTarget);if(explodeTarget){fire=false;model.flames.visible=false;document.querySelector('#fire')!.classList.remove('active');}});
bind('fire',()=>{fire=!fire;model.flames.visible=fire;document.querySelector('#fire')!.classList.toggle('active',fire);if(fire){explodeTarget=0;document.querySelector('#explode')!.classList.remove('active');}});
bind('reset',()=>{explode=explodeTarget=0;fireMix=0;viewScale=1;fire=false;model.setExplode(0);model.flames.visible=false;camera.position.set(20,12,31);controls.target.set(0,7,0);controls.autoRotate=true;document.querySelector('#spin')!.classList.add('active');for(const id of ['explode','fire'])document.querySelector('#'+id)!.classList.remove('active');document.querySelector('#selected')!.textContent='Explore the vehicle';});
const ray=new THREE.Raycaster();const pointer=new THREE.Vector2();let down=[0,0];renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
renderer.domElement.addEventListener('pointerup',e=>{if(Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;pointer.set(e.clientX/innerWidth*2-1,1-e.clientY/innerHeight*2);ray.setFromCamera(pointer,camera);const hits=ray.intersectObjects(model.parts,true).filter(h=>!h.object.userData.outline);if(hits.length){let o=hits[0].object;while(o.parent&&!o.userData.part)o=o.parent;document.querySelector('#selected')!.textContent=o.name.replaceAll('-',' ');}});
function saveBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
bind('export',async()=>{const button=document.querySelector<HTMLButtonElement>('#export')!;button.disabled=true;try{const clean=createSLSModel({outlines:false});clean.root.userData={};clean.root.traverse(o=>{o.userData={};if(o instanceof THREE.Mesh && o.material instanceof THREE.MeshToonMaterial){const old=o.material;o.material=new THREE.MeshStandardMaterial({color:old.color,roughness:.9,side:old.side});old.dispose();}});clean.root.remove(clean.flames);const result=await new GLTFExporter().parseAsync(clean.root,{binary:true});saveBlob(new Blob([result as ArrayBuffer],{type:'model/gltf-binary'}),'sls-cel.glb');clean.dispose();}finally{button.disabled=false;}});
function render(){const dt=Math.min(clock.getDelta(),.2),t=clock.elapsedTime,blend=1-Math.exp(-7*dt);explode=THREE.MathUtils.lerp(explode,explodeTarget,blend);fireMix=THREE.MathUtils.lerp(fireMix,fire?1:0,blend);const nextScale=1+.42*explode+.4*fireMix;camera.position.sub(controls.target).multiplyScalar(nextScale/viewScale).add(controls.target);viewScale=nextScale;shadow.visible=orbit.visible=!fire;model.setExplode(explode);for(let i=0;i<model.flameMeshes.length;i++)model.flameMeshes[i].scale.y=1+Math.sin(t*19+i*2)*.07;controls.update();renderer.render(scene,camera);requestAnimationFrame(render);}
Object.assign(window,{sls:{model,scene,camera,renderer,controls,setView(angle:number){controls.autoRotate=false;const a=angle*Math.PI/180;camera.position.set(Math.sin(a)*36,10,Math.cos(a)*36);controls.target.set(0,7.6,0);controls.update();renderer.render(scene,camera);},setExplode(t:number){explode=explodeTarget=t;model.setExplode(t);},manifest(){return{parts:model.parts.map(p=>({id:p.name,name:p.name,meshNames:[],componentRefs:[p.name]})),meshNames:Object.keys(model.nodes),unnamedMeshCount:0};}}});

// Keep the interface and canvas together until fonts and GPU resources are ready.
async function start(){
  await document.fonts.ready;
  await renderer.compileAsync(scene,camera);
  controls.update();
  renderer.render(scene,camera);
  requestAnimationFrame(()=>{
    const app=document.querySelector<HTMLElement>('#app')!;
    app.dataset.ready='true';
    app.setAttribute('aria-busy','false');
    document.querySelector('#startup')?.remove();
    clock.start();
    render();
  });
}
start().catch(error=>{
  const status=document.querySelector('#startup');
  if(status)status.textContent='The viewer could not load. Please reload the page.';
  console.error(error);
});
