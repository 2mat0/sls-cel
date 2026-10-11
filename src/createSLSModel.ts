import * as THREE from 'three';
import { addArtemisIILivery } from './artemisIILivery';

export type ModelOptions = { stage?: number; outlines?: boolean };
export function createSLSModel(options: ModelOptions = {}) {
  const stage = options.stage ?? 7;
  const root = new THREE.Group(); root.name = 'SLS';
  const parts: THREE.Group[] = [];
  const nodes: Record<string, THREE.Object3D> = { root };
  const bands = new THREE.DataTexture(new Uint8Array([65, 145, 255]),3,1,THREE.RedFormat);
  bands.minFilter = bands.magFilter = THREE.NearestFilter; bands.needsUpdate = true;
  const palette = { orange:0xf29136, ivory:0xfff1cc, ink:0x232336, red:0xe94c3e, steel:0x8b9aab, gold:0xf7b946 };
  const mats = Object.fromEntries(Object.entries(palette).map(([k,color])=>[k,new THREE.MeshToonMaterial({color,gradientMap:bands})]));
  const ink = new THREE.MeshBasicMaterial({color:0x1c1d2b,side:THREE.BackSide});
  let serial = 0;
  function mesh(g:THREE.BufferGeometry, m:keyof typeof palette, parent:THREE.Object3D, p:number[]=[0,0,0], name?:string, outline=true) {
    const obj = new THREE.Mesh(g,stage<3 ? mats.ivory : mats[m]);
    obj.name=name??`${parent.name}-detail-${serial++}`; obj.position.set(p[0],p[1],p[2]);obj.userData.explodeWithParent=true;parent.add(obj);nodes[obj.name]=obj;
    if (options.outlines!==false && outline) {
      const shell=g.clone();const pos=shell.getAttribute('position'),norm=shell.getAttribute('normal');
      for(let i=0;i<pos.count;i++) pos.setXYZ(i,pos.getX(i)+norm.getX(i)*.028,pos.getY(i)+norm.getY(i)*.028,pos.getZ(i)+norm.getZ(i)*.028);
      const edge=new THREE.Mesh(shell,ink);edge.name=obj.name+'-ink';edge.userData.outline=true;edge.userData.explodeWithParent=true;obj.add(edge);
    }
    return obj;
  }
  function cyl(parent:THREE.Object3D,r1:number,r2:number,h:number,p:number[],m:keyof typeof palette,name?:string,n=12) { return mesh(new THREE.CylinderGeometry(r1,r2,h,n,1,false),m,parent,p,name); }
  function box(parent:THREE.Object3D,size:number[],p:number[],m:keyof typeof palette,name?:string) { return mesh(new THREE.BoxGeometry(...size as [number,number,number]),m,parent,p,name); }
  function group(name:string,p:number[],direction:number[]) {
    const g=new THREE.Group();g.name=name;g.position.set(...p as [number,number,number]);g.userData.home=g.position.clone();g.userData.explode=new THREE.Vector3(...direction as [number,number,number]);g.userData.part=true;root.add(g);parts.push(g);nodes[name]=g;return g;
  }
  const core=group('core',[0,6.3,0],[0,0,0]);
  cyl(core,1.35,1.35,10,[0,0,0],'orange','core-body',16);
  const upper=group('upper-stack',[0,12.45,0],[0,2.8,0]);
  cyl(upper,.88,1.35,1.25,[0,-.5,0],'ivory','launch-vehicle-adapter');
  cyl(upper,.88,.88,1.15,[0,.65,0],'ivory','upper-body');
  cyl(upper,.44,.88,.7,[0,1.52,0],'ivory','orion-cover');
  const tower=group('abort-tower',[0,15.13,0],[0,4,0]);
  cyl(tower,.13,.44,1.5,[0,-.4,0],'ivory','tower-base',8);
  cyl(tower,0,.13,.9,[0,.8,0],'ivory','tower-tip',8);
  const skirt=group('engine-section',[0,1.55,0],[0,-.5,0]);cyl(skirt,1.35,1.4,.8,[0,0,0],'ivory','thermal-skirt',16);
  const flames=new THREE.Group();flames.name='exhaust';root.add(flames);flames.visible=false;
  const flameMeshes:THREE.Object3D[]=[];
  function flame(x:number,y:number,z:number,r:number,h:number){
    const g=new THREE.Group();g.position.set(x,y,z);flames.add(g);
    let offsetY=0;
    for(const [top,bottom,len,color] of [[r*.7,r,h*.2,0xffefb0],[r,r*.6,h*.36,0xffb72e],[r*.6,0,h*.44,0xef4b2f]]){
      const f=new THREE.Mesh(new THREE.CylinderGeometry(top,bottom,len,7),new THREE.MeshBasicMaterial({color}));f.position.y=-offsetY-len/2;offsetY+=len;g.add(f);
    }flameMeshes.push(g);
  }
  for(let i=0;i<4;i++) {
    const x=(i%2?1:-1)*.62,z=(i<2?1:-1)*.62;
    const bell=group('engine-'+i,[x,.65,z],[x*.9,-1.25,z*.9]);
    cyl(bell,.27,.46,.84,[0,0,0],'steel','bell-'+i,12);
    cyl(bell,.43,.43,.08,[0,-.44,0],'ink','bell-throat-'+i,12);
    if(stage>=2) for(let j=0;j<3;j++) cyl(bell,.32+j*.045,.34+j*.045,.045,[0,.15-j*.18,0],'ink');
    flame(x,.18,z,.38,2.4);
  }
  for(const [side,x] of [['port',-2.05],['starboard',2.05]] as const){
    const booster=group('booster-'+side,[x,4.9,0],[Math.sign(x)*2.6,-.5,0]);
    cyl(booster,.625,.625,8,[0,0,0],'ivory','booster-body-'+side);
    const nose=new THREE.Group();nose.name='nose-'+side;nose.userData.explodeWithParent=true;booster.add(nose);nodes[nose.name]=nose;
    cyl(nose,0,.625,1.05,[0,4.5,0],'ivory','booster-nose-'+side);
    const nozzle=new THREE.Group();nozzle.name='nozzle-'+side;nozzle.userData.explodeWithParent=true;booster.add(nozzle);nodes[nozzle.name]=nozzle;
    cyl(nozzle,.63,.77,.58,[0,-4.2,0],'steel','booster-nozzle-'+side);
    cyl(nozzle,.71,.71,.09,[0,-4.52,0],'ink');
    flame(x,.34,0,.68,3.8);
    if(stage>=1){
      for(let j=0;j<6;j++){
        const y=-3.82+j*1.52;
        cyl(booster,.652,.652,.075,[0,y,0],'ink');
        cyl(booster,.656,.656,.11,[0,y+.095,0],'ivory');
      }
      for(const y of [-3.4,3.25]) for(let k=0;k<12;k+=2){
        const arc=new THREE.CylinderGeometry(.635,.635,.22,24,1,true,k*Math.PI/6,Math.PI/6);
        mesh(arc,'ink',booster,[0,y,0],undefined,false);
      }
      for(const y of [-2.9,2.8]){
        box(core,[.65,.19,.24],[x*.69,y-1.4,0],'steel');
      }
      for(let j=0;j<4;j++) for(const a of [-Math.PI/3,Math.PI/3]) {const target=box(booster,[.13,.5,.08],[Math.sin(a)*.63,-2.8+j*1.5,Math.cos(a)*.63],'ink');target.rotation.y=a;}
      for(let j=0;j<3;j++) cyl(booster,.68,.68,.045,[0,-3.5+j*.18,0],'gold');
    }
  }
  if(stage>=1){
    const ribs=new THREE.Group();ribs.name='intertank-ribs';ribs.userData.explodeWithParent=true;core.add(ribs);nodes[ribs.name]=ribs;
    for(let j=0;j<32;j++) {const a=j/32*Math.PI*2;const b=box(ribs,[.045,1.05,.045],[Math.sin(a)*1.355,.75,Math.cos(a)*1.355],'gold');b.rotation.y=a;}
    const pipe=new THREE.Group();pipe.name='feed-line';pipe.userData.explodeWithParent=true;core.add(pipe);nodes[pipe.name]=pipe;
    cyl(pipe,.065,.065,8,[.62,-.55,1.22],'ivory','external-feed-line',6);
    for(let j=0;j<8;j++) box(pipe,[.19,.09,.15],[.62,-4+j,1.22],'ink');
    for(const y of [-4.45,.18,1.3,4.8]) cyl(core,1.37,1.37,.055,[0,y,0],'ink',undefined,16);
    for(let j=0;j<8;j++) {const a=j*Math.PI/4;box(skirt,[.19,.3,.07],[Math.sin(a)*1.34,0,Math.cos(a)*1.34],'steel').rotation.y=a;}
    for(const y of [-1.1,.04,1.1]) cyl(upper,y<0?1.12:.9,y<0?1.12:.9,.07,[0,y,0],'ink');
    for(let j=0;j<4;j++) {const a=j*Math.PI/2;const n=cyl(tower,.055,.13,.32,[Math.sin(a)*.27,-.55,Math.cos(a)*.27],'ink',undefined,6);n.rotation.z=Math.cos(a)*.85;n.rotation.x=Math.sin(a)*.85;}
  }
  const livery=stage>=3?addArtemisIILivery(nodes,bands):[];
  root.userData.sculptRuntime={nodes,parts,livery,destructionGroups:parts.map(p=>({id:p.name,componentRefs:[p.name]})),sockets:{upper:[0,11.3,0],port:[-2.05,4.9,0],starboard:[2.05,4.9,0]},colliders:parts.map(p=>({id:p.name,type:'bounds'}))};
  return {root,parts,nodes,flames,flameMeshes,setExplode(t:number){for(const p of parts) p.position.copy(p.userData.home).addScaledVector(p.userData.explode,t);},dispose(){const materials=new Set<THREE.Material>();root.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});materials.forEach(m=>m.dispose());Object.values(mats).forEach(m=>m.dispose());ink.dispose();bands.dispose();}};
}
