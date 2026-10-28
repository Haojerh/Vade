export type PermissionTone = 'read' | 'workspace' | 'auto' | 'full' | 'neutral';
export function permissionPresentation(option:{value:string;label:string;description?:string}) {
  const known:Record<string,{label:string;description:string;tone:PermissionTone;icon:'eye'|'hand'|'folder'|'shield'|'alert'}>={
    'read-only':{label:'Read only',description:'Read files without making changes.',tone:'read',icon:'eye'},
    'workspace-write':{label:'Workspace access',description:'Allow workspace changes; ask before broader access.',tone:'workspace',icon:'folder'},
    'danger-full-access':{label:'Full access',description:'Allow broader access without native sandbox restrictions.',tone:'full',icon:'alert'},
    manual:{label:'Ask for approval',description:'Keep native approval prompts enabled.',tone:'read',icon:'hand'},
    auto:{label:'Approve for me',description:'Let the provider review approval requests.',tone:'auto',icon:'shield'},
    yolo:{label:'Full access',description:'Skip native approval prompts. Provider and OS restrictions still apply.',tone:'full',icon:'alert'},
    acceptEdits:{label:'Accept edits',description:'Approve file edits; keep other native checks.',tone:'workspace',icon:'folder'},
    plan:{label:'Plan',description:'Use the provider’s planning mode.',tone:'read',icon:'eye'},
  };
  const presentation=known[option.value];
  return presentation?{...presentation,label:option.value==='auto'&&option.label==='Auto'?'Auto':presentation.label,description:option.description||presentation.description}:{label:option.label,description:option.description,tone:'neutral' as PermissionTone,icon:'shield' as const};
}
