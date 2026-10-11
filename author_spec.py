import json,copy
from pathlib import Path
p=Path('object-sculpt-spec.json'); s=json.loads(p.read_text()); a=s['preSpecAssessment']
a['objectClass'].update(primaryType='heavy lift launch vehicle',primaryDomain='object',formLanguage=['hard-surface','mechanical'],structureKind=['compound object','repeated modules'],motionPotential=['detachable','whole-object transform'],materialFamilies=['insulating foam','painted metal'],notes='Stylized Block 1 SLS; single NASA reference, hidden hardware inferred.')
a['complexity']['scores']={k:2 for k in a['complexity']['scores']}; a['complexity']['estimatedCounts']={'macroComponents':5,'mesoComponents':8,'microFeatureGroups':3,'materialLayers':4,'repetitionSystems':2};a['complexity']['reasoning']=['Bilateral five-segment boosters flank a cylindrical orange core with four engine bells and a tapered upper stack.']
s['qualityContract']['definitionOfDone']=['Recognizable stylized Block 1 silhouette: wide orange core, twin five-segment white boosters, four bells and Orion abort tower.','Three discrete light bands, faceted surfaces and black outlines deliver the requested old cel-shaded game treatment.','Named assemblies explode, pick and reassemble; four cardinal views remain volumetric.']
s['risks']=['Art-directed proportions rather than engineering dimensions.','Rear hardware inferred; PBR extraction and photo projection are inapplicable to the explicitly requested cel shading.']
base=copy.deepcopy(s['componentTree'][0]); comps=[]
def part(id,parent,level,primitive,dim,pos,mat,features=[]):
 c=copy.deepcopy(base); c.update(id=id,name=id,parent=parent,level=level,primitive=primitive,material=mat,materialLayers=[mat],confidence=.85,topologyClass='assembled-solid',topologyRationale='Discrete fabricated axisymmetric metal or insulated assembly.',localFeatures=[{'id':f,'type':'raised ridge','placement':'component surface','size':.08,'confidence':.8,'evidenceRefs':['full-object']} for f in features]);c['dimensions'].update(width=dim[0],height=dim[1],depth=dim[2]); c['transform']['position']=pos;c['actionProfile']['animationRole']='static-part' if parent else 'root';c['actionProfile']['sockets']=[{'id':id+'-socket','position':[0,0,0],'axis':[0,1,0]}];c['attachment']=None if not parent else {'parentSocket':parent+'-socket','localStart':[0,-dim[1]/2,0],'localEnd':[0,dim[1]/2,0],'contactType':'overlap','overlap':.04,'embedDepth':.04,'gapTolerance':.01}; comps.append(c)
part('root',None,'macro','box',[.01,.01,.01],[0,0,0],'ink')
part('core','root','macro','cylinder',[2.7,10,2.7],[0,6.3,0],'orange',['feed-line','intertank-ribs'])
for side,x in [('port',-2.05),('starboard',2.05)]:
 part('booster-'+side,'root','macro','cylinder',[1.25,8,1.25],[x,4.9,0],'ivory',['segment-rings-'+side,'checker-'+side])
 part('nose-'+side,'booster-'+side,'meso','cone',[1.25,1,1.25],[0,4.5,0],'ivory')
 part('nozzle-'+side,'booster-'+side,'meso','cone',[1.3,.7,1.3],[0,-4.3,0],'ink')
part('upper-stack','root','macro','cylinder',[1.85,2.5,1.85],[0,12.5,0],'ivory',['adapter-ring','capsule-seam'])
part('abort-tower','upper-stack','meso','cone',[.35,2,.35],[0,2.3,0],'ivory',['abort-nozzles'])
part('engine-section','core','meso','cylinder',[2.7,.85,2.7],[0,-4.65,0],'ivory',['thermal-panels'])
for i in range(4):
 part('engine-'+str(i),'core','meso','cone',[.85,.85,.85],[(-1 if i%2 else 1)*.65,-5.5,(-1 if i//2 else 1)*.65],'ink')
part('intertank-ribs','core','micro','cylinder',[2.74,1,2.74],[0,.6,0],'orange')
part('feed-line','core','micro','cylinder',[.12,8,.12],[.8,-.4,1.12],'ivory')
s['componentTree']=comps
details=[]
for c in comps:
 for f in c['localFeatures']: details.append({'id':f['id'],'kind':'linework','description':f['id'],'componentRef':c['id'],'featureRef':f['id'],'evidenceRefs':['full-object'],'confidence':.8})
a['detailInventory']['details']=details;a['detailInventory']['targetMinDetails']=9
mat=copy.deepcopy(s['materials'][0]);s['materials']=[]
for id,col in [('orange','#ed7d27'),('ivory','#fff2ce'),('ink','#1b2030'),('red','#ef4f43')]:
 m=copy.deepcopy(mat);m.update(id=id,name=id,baseColor=col,color=col,type='toon',shaderModel='MeshToonMaterial; three-band gradient, inverted hull ink outline',notes='Art-directed flat albedo for requested cel shading. No photographic surface matching.');m['albedo']['dominant']=col;m['colorVariation']['pattern']='graphic panels';m['localOverrides']=[{'id':id+'-accent','region':'seams','color':'#292638','roughness':.95,'evidenceRefs':['full-object']}];s['materials'].append(m)
s['repetitionSystems']=[{'id':'five-segments','componentRefs':['booster-port','booster-starboard'],'count':10,'pattern':'linear','distribution':'five equal axial segments per booster'}, {'id':'rib-flutes','componentRefs':['intertank-ribs'],'count':32,'pattern':'radial','distribution':'full circumference'}]
for b in s['buildPasses']: b['componentRefs']=[c['id'] for c in comps];b['acceptance']=[b['goal'],'Subject identity and authored cel-shading contract remain readable.']
s['performanceBudget'].update(targetTriangles=25000,maxDrawCalls=400,fpsTarget=60)
s['scores']={k:.85 for k in s['scores']}
s['featureReviewTargets']=[{'id':id,'name':name,'importance':'critical','componentRefs':refs,'passIds':[b['id'] for b in s['buildPasses']],'threshold':.7,'criteria':[name],'evidenceRefs':['full-object']} for id,name,refs in [('silhouette','orange core and twin boosters',['core','booster-port','booster-starboard']),('tower','tapered Orion stack and abort tower',['upper-stack','abort-tower']),('engines','four core bells',['engine-0','engine-1','engine-2','engine-3'])]]
s['scores']={k:3 for k in s['scores']}
s['lookDevTargets']['qualityPriority']='stylized-cel'
s['lookDevTargets']['materialPass']['referencePbrExtraction']['requiredWhenSourceImagePresent']=False
s['lightingFromPhoto']=[{'type':'directional','role':'key','position':[-8,16,10],'intensity':3,'color':'#fff1d0'},{'type':'hemisphere','role':'fill','intensity':1,'color':'#b6d4f0'}]
for c in comps: c['colorMaterialRecipe']={'dominantAlbedo':'rgba(237, 125, 39, 1)' if c['material']=='orange' else 'rgba(255, 242, 206, 1)','secondaryAlbedo':'rgba(100, 86, 91, 1)','materialClass':'painted-metal','materialClassConfidence':.85}
s['lightingFromPhoto'].append({'role':'rim','position':[5,10,-8],'intensity':1,'notes':'No tone mapping, exposure 1; graphic ground shadow disc.'})
for c in comps: c['colorMaterialRecipe']['materialClass']='metal'
for f in s['featureReviewTargets']: f['tier']='critical'
for d in details: d['mapsTo']={'ref':d['featureRef']}
p.write_text(json.dumps(s,indent=2));Path('assessment.json').write_text(json.dumps({'preSpecAssessment':a,'qualityContract':s['qualityContract'],'localSpecSearch':s['localSpecSearch']},indent=2))
Path('evidence/intake.md').write_text('NASA reference: bilateral cylindrical orange core, twin segmented white boosters, tapered upper adapter and abort tower; four visible core exhausts. Bands, rib grid, external feed line, thermal skirt and checker accents observed. Rear and internal hardware inferred. Conditional suitability: clear silhouette, rotational forms, but flight exhaust occludes nozzle interiors. Explicit cel-shading request permits nonphotographic finish. Projection and reference PBR are not applicable. Intended use: interactive browser prop.\n')
