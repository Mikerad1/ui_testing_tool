import type { Store } from '../memory/store.js';
import type { BrowserAdapter, CapturedBrowserApproval } from '../browser/adapter.js';
import { parseStoredWorkflowDocument, resolveWorkflowVariables, type WorkflowDocument, type WorkflowStep } from './contract.js';
import { createBrowserWorkflowDriver, type WorkflowDriver, type WorkflowExecutableStep, type WorkflowFailureCaptureMode, type WorkflowWaitStep } from './browser-driver.js';

const RUN_LIMIT_MS=5*60_000;
type SessionLike={id:string;closed:boolean};
type Approval=CapturedBrowserApproval;
type DesktopRedaction={applied:boolean;method:string;scope:string;warning:string};
type DesktopFailureCapture={status:'captured';artifactRef:string;redaction:DesktopRedaction}|{status:'disabled'|'unavailable'|'capture_failed'|'cleanup_failed'};
export type WorkflowRunnerOptions={store:Store;session:SessionLike;workflowId:string;backend?:'browser'|'tauri';role?:string;environment?:string;knowledgeRoot?:string;env?:NodeJS.ProcessEnv;disableFailureCapture?:boolean;safeOutcome?:boolean;captureDesktopFailure?:()=>Promise<DesktopFailureCapture>;removeDesktopFailureArtifact?:(ref:string)=>Promise<'removed'|'unavailable'|'failed'>};
type RunnerOptions=WorkflowRunnerOptions&{browser:BrowserAdapter;expectedRevision:number;authorize:(action:string,target:any,revision:number)=>Promise<Approval|undefined>};
type SafeCode='precondition_failed'|'missing_variable'|'timeout'|'approval_denied'|'revision_conflict'|'navigation_denied'|'target_invalid'|'assertion_failed'|'action_failed'|'interrupted';
export type WorkflowPreflightErrorCode='precondition_failed'|'approval_denied';
export class WorkflowPreflightError extends Error {
  constructor(readonly code:WorkflowPreflightErrorCode){super(code);this.name='WorkflowPreflightError';}
}
type Outcome={status:'passed'|'failed'|'interrupted';errorCode?:SafeCode;assertionPassed?:boolean;observedCount?:number;artifactRef?:string};
const screenId=(value:string)=>value.replace(/^(screen:|role:)/,'');

export function safeWorkflowErrorCode(error:unknown):SafeCode{const message=error instanceof Error?error.message:'';if(/precondition_failed/i.test(message))return'precondition_failed';if(/approval_denied/i.test(message))return'approval_denied';if(/revision[ _]conflict/i.test(message))return'revision_conflict';if(/navigation.*denied|origin not allowed/i.test(message))return'navigation_denied';if(/timeout|timed out/i.test(message))return'timeout';if(/unique and visible|target|locator|expired snapshot/i.test(message))return'target_invalid';return'action_failed';}

export async function runWorkflow(options:RunnerOptions){const driver=createBrowserWorkflowDriver({store:options.store,browser:options.browser,authorize:options.authorize});if(options.expectedRevision!==options.browser.revision){try{driver.cleanup();}catch{}return options.safeOutcome?{status:'failed' as const,errorCode:'revision_conflict' as const}:{ok:false,status:'failed' as const,errorCode:'revision_conflict' as const};}return runWorkflowWithDriver(options,driver);}

/** Executes shared workflow orchestration with a caller-supplied backend driver. */
export async function runWorkflowWithDriver(options:WorkflowRunnerOptions,driver:WorkflowDriver){try{return await runWorkflowInner(options,driver);}finally{try{driver.cleanup();}catch{}}}

async function runWorkflowInner(options:WorkflowRunnerOptions,driver:WorkflowDriver){
  const {store,session,workflowId}=options;
  const earlyFailure=(errorCode:SafeCode)=>options.safeOutcome?{status:'failed' as const,errorCode}:{ok:false,status:'failed' as const,errorCode};
  const workflowNode=(typeof store.currentYamlWorkflow==='function'?store.currentYamlWorkflow(workflowId):store.getByTypeKey('workflow',workflowId)) as any;
  if(!workflowNode||workflowNode.origin!=='yaml')return earlyFailure('precondition_failed');
  let workflow:WorkflowDocument;
  try{workflow=parseStoredWorkflowDocument(JSON.parse(workflowNode.attributes_json));}catch{return earlyFailure('precondition_failed');}
  const metadata:Record<string,unknown>={...(options.backend?{backend:options.backend}:{}),...(options.role?{role:options.role}:{}),...(options.environment?{environment:options.environment}:{})};const boundedNames:string[]=[];for(const name of Object.keys(workflow.variables??{})){const candidate=[...boundedNames,name];if(JSON.stringify({...metadata,variable_names:candidate}).length>900)break;boundedNames.push(name);}if(boundedNames.length)metadata.variable_names=boundedNames;
     const workflowSnapshotHash=store.workflowSnapshotHash(workflowId);if(!workflowSnapshotHash)return earlyFailure('precondition_failed');
     if(options.safeOutcome){for(const step of workflow.steps){if(step.action==='fill'||step.action==='type'||step.action==='select'){const match=step.value.match(/^\$\{\{\s*variables\.([A-Z_][A-Z0-9_]*)\s*\}\}$/),declaration=match&&workflow.variables?.[match[1]!];if(!declaration?.from_env||declaration.sensitive!==true)return earlyFailure('precondition_failed');}}}
     try{await driver.validateWorkflow(workflow);}catch(error){return earlyFailure(error instanceof WorkflowPreflightError?error.code:'precondition_failed');}
      const runMetadata=options.safeOutcome?(options.backend?{backend:options.backend}:{}):metadata;
      const runId=store.createRun(session.id,workflowNode.id,runMetadata,workflowSnapshotHash),started=Date.now();driver.beginRun({workflow,workflowNodeId:workflowNode.id,workflowId:workflow.id,runId,knowledgeRoot:options.knowledgeRoot});let active:{stepId:string;attempt:number;ordinal:number;action:string;started:number}|undefined,attemptCount=0,evidenceAttempted=false;const proposalIds:string[]=[];
  const startAttempt=(stepId:string,ordinal:number,attempt:number,action:string)=>{const at=Date.now();store.createWorkflowStepAttempt({runId,stepId,ordinal,attempt,action,startedAt:new Date(at).toISOString()});attemptCount++;active={stepId,attempt,ordinal,action,started:at};};
  const finishAttempt=(outcome:Outcome)=>{if(!active)return;store.finishWorkflowStepAttempt({runId,stepId:active.stepId,attempt:active.attempt,status:outcome.status,finishedAt:new Date().toISOString(),durationMs:Math.min(10_000_000,Math.max(0,Date.now()-active.started)),errorCode:outcome.errorCode,assertionPassed:outcome.assertionPassed,observedCount:outcome.observedCount,artifactRef:outcome.artifactRef??null});active=undefined;};
   let failure:SafeCode|undefined,capture:{snapshot?:Record<string,number>;console_errors?:number;screenshot?:string|null;desktop_screenshot?:string|null;desktop_screenshot_status?:DesktopFailureCapture['status']|'persistence_failed';desktop_screenshot_redaction?:DesktopRedaction}={};
  const failureArtifactRef=()=>typeof capture.screenshot==='string'?capture.screenshot:typeof capture.desktop_screenshot==='string'?capture.desktop_screenshot:undefined;
  const persistTerminalEvidence=async(status:'passed'|'failed'|'interrupted')=>{if(evidenceAttempted)return;evidenceAttempted=true;const metadata={step_count:workflow.steps.length,attempt_count:Math.max(0,Math.min(302,attemptCount)),duration_ms:Math.max(0,Math.min(10_000_000,Date.now()-started))},desktopRef=capture.desktop_screenshot,artifactRef=failureArtifactRef();try{if(typeof desktopRef==='string')store.addWorkflowTerminalEvidence({run_id:runId,subject_node_id:workflowNode.id,outcome:status,metadata,artifact_ref:artifactRef,desktop_artifact_ref:desktopRef});else store.addEvidence({run_id:runId,subject_node_id:workflowNode.id,kind:'workflow',outcome:status,metadata,...(artifactRef?{artifact_ref:artifactRef}:{})});}catch{if(typeof desktopRef==='string'){capture.desktop_screenshot=null;capture.desktop_screenshot_status='persistence_failed';let referencesCleared=false;try{store.clearWorkflowAttemptArtifactReferences(runId,desktopRef);referencesCleared=true;}catch{capture.desktop_screenshot_status='cleanup_failed';}if(referencesCleared){let cleanup:'removed'|'unavailable'|'failed'='unavailable';try{cleanup=await options.removeDesktopFailureArtifact?.(desktopRef)??'unavailable';}catch{cleanup='failed';}if(cleanup!=='removed')capture.desktop_screenshot_status='cleanup_failed';}try{if(typeof capture.screenshot==='string')store.addEvidence({run_id:runId,subject_node_id:workflowNode.id,kind:'workflow',outcome:status,metadata,artifact_ref:capture.screenshot});}catch{}}}};
    const captureFailure=async()=>{if(options.disableFailureCapture)return;for(const mode of workflow.on_failure?.capture??[]){if(mode==='desktop_screenshot'){capture.desktop_screenshot=null;capture.desktop_screenshot_status='unavailable';if(options.captureDesktopFailure)try{const result=await options.captureDesktopFailure();capture.desktop_screenshot_status=result.status;if(result.status==='captured'){capture.desktop_screenshot=result.artifactRef;capture.desktop_screenshot_redaction=result.redaction;}}catch{capture.desktop_screenshot_status='capture_failed';}}else{const browserMode=mode as WorkflowFailureCaptureMode;if(driver.captureFailure)Object.assign(capture,await driver.captureFailure(browserMode));}}};
  let variables:Record<string,string>={};
  try{
    startAttempt('__preflight__',0,1,'assert');
    try{
       if(!driver.validateSession(session))throw Error('interrupted');
      if(workflow.requires?.role&&screenId(workflow.requires.role)!==screenId(options.role??''))throw Error('precondition_failed');
      if(workflow.requires?.environment?.length&&!workflow.requires.environment.includes(options.environment??''))throw Error('precondition_failed');
      try{variables=resolveWorkflowVariables(workflow,options.env??process.env);}catch{throw Error('missing_variable');}
        if(workflow.start_screen){if(!driver.routeMatches)throw Error('precondition_failed');const matches=await driver.routeMatches(workflow.start_screen);if(matches===false)throw Error('precondition_failed');if(matches===undefined&&!(workflow.preconditions?.length))throw Error('precondition_failed');}
       for(const check of workflow.preconditions??[]){const remaining=Math.max(1,Math.min(5_000,RUN_LIMIT_MS-(Date.now()-started)));const r=await driver.assert(check,variables,remaining);if(!r.passed)throw Error('precondition_failed');}
      finishAttempt({status:'passed'});
      }catch(error){const code=!driver.validateSession(session)?'interrupted':error instanceof Error&&['missing_variable','precondition_failed'].includes(error.message)?error.message as SafeCode:safeWorkflowErrorCode(error);failure=code;await captureFailure();finishAttempt({status:code==='interrupted'?'interrupted':'failed',errorCode:code,artifactRef:failureArtifactRef()});}
    if(!failure){
      for(let index=0;index<workflow.steps.length;index++){
        if(!driver.validateSession(session)){failure='interrupted';break;}if(Date.now()-started>=RUN_LIMIT_MS){failure='timeout';break;}
        const step=workflow.steps[index]!;const maxAttempts=step.action==='wait'?Math.min(3,step.max_attempts??1):1;let done=false;
        for(let attempt=1;attempt<=maxAttempts&&!done;attempt++){
          if(!driver.validateSession(session)){failure='interrupted';break;}if(Date.now()-started>=RUN_LIMIT_MS){failure='timeout';break;}
          startAttempt(step.id,index+1,attempt,step.action);
          try{
            const remaining=Math.max(1,Math.min(step.timeout_ms??30_000,RUN_LIMIT_MS-(Date.now()-started)));driver.setActionTimeout(remaining);
            let outcome:Outcome={status:'passed'};
            if(step.action==='wait')await driver.wait(step as WorkflowWaitStep,variables,remaining);
            else if(step.action==='assert'){const r=await driver.assert(step,variables,remaining);outcome={status:r.passed?'passed':'failed',assertionPassed:r.passed,observedCount:r.observedCount,...(!r.passed?{errorCode:'assertion_failed' as const}:{})};}
            else await driver.execute(step as WorkflowExecutableStep,variables,remaining);
              if(outcome.status==='failed'){failure=outcome.errorCode??'action_failed';await captureFailure();finishAttempt({...outcome,artifactRef:failureArtifactRef()});done=true;}else{if(!driver.validateSession(session)){failure='interrupted';finishAttempt({status:'interrupted',errorCode:'interrupted'});}else finishAttempt(outcome);done=true;}
            }catch(error){const code=!driver.validateSession(session)?'interrupted':safeWorkflowErrorCode(error),status=code==='interrupted'?'interrupted':'failed';if(step.action==='wait'&&code==='timeout'&&attempt<maxAttempts&&Date.now()-started<RUN_LIMIT_MS){finishAttempt({status,errorCode:code});continue;}failure=code;if(code==='target_invalid'&&driver.proposeFallbacks)proposalIds.push(...await driver.proposeFallbacks(step));await captureFailure();finishAttempt({status,errorCode:code,artifactRef:failureArtifactRef()});done=true;}
        }
        if(failure)break;
      }
    }
      if(!failure&&workflow.end_screen){startAttempt('__postflight__',101,1,'assert');try{if(!driver.validateSession(session))throw Error('interrupted');if(!driver.routeMatches)throw Error('precondition_failed');const matches=await driver.routeMatches(workflow.end_screen);if(matches===false)throw Error('precondition_failed');finishAttempt({status:'passed'});}catch(error){const code=!driver.validateSession(session)?'interrupted':safeWorkflowErrorCode(error);failure=code;await captureFailure();finishAttempt({status:code==='interrupted'?'interrupted':'failed',errorCode:code,artifactRef:failureArtifactRef()});}}
    if(failure&&!Object.keys(capture).length)await captureFailure();
      const status=!driver.validateSession(session)||failure==='interrupted'?'interrupted':failure?'failed':'passed';if(active)finishAttempt({status:'interrupted',errorCode:'interrupted'});await persistTerminalEvidence(status);driver.setActionTimeout(30_000);store.finishRun(runId,status);if(options.safeOutcome)return{status,...(runId?{run_id:runId}:{}),...(failure?{errorCode:failure}:{})};return{ok:!failure,run_id:runId,status,...(failure?{errorCode:failure}:{}),step_attempts:(store.getRunReport(runId) as any)?.stepAttempts??[],...(proposalIds.length?{locator_proposals:proposalIds.slice(0,8).map(id=>({id,status:'pending'}))}:{}),...(Object.keys(capture).length?{capture}:{})};
  }catch{if(active){try{finishAttempt({status:!driver.validateSession(session)?'interrupted':'failed',errorCode:!driver.validateSession(session)?'interrupted':'action_failed'});}catch{}}const status=!driver.validateSession(session)?'interrupted':'failed';await persistTerminalEvidence(status);try{driver.setActionTimeout(30_000);}catch{}store.finishRun(runId,status);if(options.safeOutcome)return{status,run_id:runId,errorCode:status==='interrupted'?'interrupted':'action_failed'};return{ok:false,run_id:runId,status,errorCode:status==='interrupted'?'interrupted':'action_failed',step_attempts:(store.getRunReport(runId) as any)?.stepAttempts??[],...(proposalIds.length?{locator_proposals:proposalIds.slice(0,8).map(id=>({id,status:'pending'}))}:{})};}
}
