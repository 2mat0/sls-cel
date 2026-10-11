import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { liveryVectors } from './liveryVectors';

type Layer = { geometry: THREE.BufferGeometry; color: THREE.Color };
type Placement = { id: string; width: number; y: number; radius: number; segments: number; yaw?: number; rotation?: number; radiusAtY?: (y:number)=>number };
const svgLoader = new SVGLoader();
const font = new FontLoader().parse(fontData);

// Adaptive subdivision keeps large glyph triangles on the cylindrical skin,
// rather than letting their interiors cut through the rocket's facets.
function subdivide(geometry:THREE.BufferGeometry):THREE.BufferGeometry {
  const raw=geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const p=raw.getAttribute('position'),out:number[]=[];
  function triangle(a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3,depth:number) {
    if(depth<7 && Math.max(a.distanceTo(b),b.distanceTo(c),c.distanceTo(a))>.1){
      const ab=a.clone().add(b).multiplyScalar(.5),bc=b.clone().add(c).multiplyScalar(.5),ca=c.clone().add(a).multiplyScalar(.5);
      triangle(a,ab,ca,depth+1);triangle(ab,b,bc,depth+1);triangle(ca,bc,c,depth+1);triangle(ab,bc,ca,depth+1);
    }else out.push(...a.toArray(),...b.toArray(),...c.toArray());
  }
  for(let i=0;i<p.count;i+=3) triangle(new THREE.Vector3().fromBufferAttribute(p,i),new THREE.Vector3().fromBufferAttribute(p,i+1),new THREE.Vector3().fromBufferAttribute(p,i+2),0);
  raw.dispose();const result=new THREE.BufferGeometry();result.setAttribute('position',new THREE.Float32BufferAttribute(out,3));return result;
}

function svgLayers(svg:string):Layer[]{
  const layers:Layer[]=[];
  for(const path of svgLoader.parse(svg).paths){
    const style=path.userData?.style;
    if(style?.fill!=='none') for(const shape of SVGLoader.createShapes(path)) layers.push({geometry:new THREE.ShapeGeometry(shape,10),color:path.color.clone()});
    if(style?.stroke && style.stroke!=='none') for(const subpath of path.subPaths){
      const geometry=SVGLoader.pointsToStroke(subpath.getPoints(20),style);
      if(geometry)layers.push({geometry,color:new THREE.Color(style.stroke)});
    }
  }
  return layers;
}

export function addArtemisIILivery(nodes:Record<string,THREE.Object3D>,gradientMap:THREE.Texture){
  const markings:string[]=[];
  function place(layers:Layer[],parent:THREE.Object3D,placement:Placement,topDown=true){
    const {id,width,y,radius,segments,yaw=0,rotation=0}=placement;
    const bounds=new THREE.Box3();
    for(const layer of layers){layer.geometry.computeBoundingBox();bounds.union(layer.geometry.boundingBox!);}
    const center=bounds.getCenter(new THREE.Vector3()),scale=width/bounds.getSize(new THREE.Vector3()).x;
    const group=new THREE.Group();group.name=id;group.userData.explodeWithParent=true;group.userData.livery=true;parent.add(group);nodes[id]=group;markings.push(id);
    const colorGroups=new Map<string,THREE.BufferGeometry[]>();
    for(let layerIndex=0;layerIndex<layers.length;layerIndex++){
      const layer=layers[layerIndex],geometry=layer.geometry;
      geometry.translate(-center.x,-center.y,0);geometry.scale(scale,topDown?-scale:scale,1);
      if(topDown){const g=geometry.index;if(g)for(let i=0;i<g.count;i+=3){const b=g.getX(i+1);g.setX(i+1,g.getX(i+2));g.setX(i+2,b);}else{const p=geometry.getAttribute('position');for(let i=0;i<p.count;i+=3){const b=new THREE.Vector3().fromBufferAttribute(p,i+1),c=new THREE.Vector3().fromBufferAttribute(p,i+2);p.setXYZ(i+1,c.x,c.y,c.z);p.setXYZ(i+2,b.x,b.y,b.z);}}}
      geometry.rotateZ(rotation);const bent=subdivide(geometry);geometry.dispose();
      const p=bent.getAttribute('position');
      for(let i=0;i<p.count;i++){
        const h=y+p.getY(i),r=placement.radiusAtY?.(h)??radius,a=yaw+p.getX(i)/r;
        const sector=2*Math.PI/segments,within=THREE.MathUtils.euclideanModulo(a,sector)-sector/2;
        const skin=r*Math.cos(Math.PI/segments)/Math.cos(within)+.034+layerIndex*.00018;
        p.setXYZ(i,Math.sin(a)*skin,h,Math.cos(a)*skin);
      }
      const color=layer.color.getHexString();const list=colorGroups.get(color)??[];list.push(bent);colorGroups.set(color,list);
    }
    for(const [color,geometries] of colorGroups){
      const geometry=mergeGeometries(geometries)!;geometries.forEach(g=>g.dispose());geometry.computeVertexNormals();
      const material=new THREE.MeshToonMaterial({color:'#'+color,gradientMap,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
      const mesh=new THREE.Mesh(geometry,material);mesh.name=id+'-'+color;mesh.userData.explodeWithParent=true;mesh.userData.livery=true;group.add(mesh);nodes[mesh.name]=mesh;
    }
  }
  function word(text:string,color:number,parent:THREE.Object3D,p:Placement){place([{geometry:new THREE.ShapeGeometry(font.generateShapes(text,1),10),color:new THREE.Color(color)}],parent,p,false);}
  function flag(parent:THREE.Object3D,p:Placement){
    const stars=Array.from({length:50},(_,i)=>{const row=Math.floor(i/11)*2+(i%11>=6?1:0),col=i%11>=6?i%11-6:i%11;const x=5+(col+(row%2? .5:0))*6.2, y=3.5+row*3.1;return `<circle cx="${x}" cy="${y}" r="1" fill="#ffffff"/>`;}).join('');
    const stripes=Array.from({length:7},(_,i)=>`<rect x="0" y="${i*8}" width="100" height="4" fill="#c63233"/>`).join('');
    place(svgLayers(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="52" fill="#ffffff"/>${stripes}<rect width="40" height="28" fill="#183a78"/>${stars}</svg>`),parent,p);
  }
  for(const side of ['port','starboard']){
    const booster=nodes['booster-'+side];
    place(svgLayers(liveryVectors.america250),booster,{id:'america250-'+side,width:.91,y:2.78,radius:.625,segments:12});
    place(svgLayers(liveryVectors.worm),booster,{id:'nasa-worm-'+side,width:2.18,y:-.25,radius:.625,segments:12,rotation:Math.PI/2});
  }
  const upper=nodes['upper-stack'];
  place(svgLayers(liveryVectors.insignia),upper,{id:'orion-nasa-insignia',width:.65,y:.64,radius:.88,segments:12});
  word('esa',0x183a78,upper,{id:'orion-esa',width:.36,y:.23,radius:.88,segments:12});
  place(svgLayers(liveryVectors.worm),upper,{id:'orion-nasa-worm',width:.74,y:1.14,radius:.88,segments:12});
  flag(upper,{id:'orion-flag',width:.28,y:1.59,radius:.6,segments:12,radiusAtY:h=>.88-(h-1.17)*(.44/.7)});
  word('U\nS\nA',0x252535,upper,{id:'orion-usa',width:.22,y:.65,radius:.88,segments:12,yaw:Math.PI});
  return markings;
}
