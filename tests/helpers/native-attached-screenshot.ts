import path from 'node:path';
import { DesktopAdapter } from '../../src/browser/desktop-adapter.js';
import type { Config } from '../../src/config/config.js';

const endpoint=process.env.UMB_ATTACH_ENDPOINT!,sessionId=process.env.UMB_ATTACH_SESSION!;
const root=process.env.UMB_ATTACH_ROOT!;
const config={provider:'desktop',project:{id:'native-attach',name:'native attach',base_url:'tauri://localhost'},browser:{headless:true,viewport:{width:800,height:600},allowed_origins:[]},desktop:{automation:{endpoint,session_id:sessionId},window:{screenshot_mode:'webview'},visual:{}},artifacts:{directory:path.join(root,'artifacts')}} as unknown as Config;
const adapter=new DesktopAdapter(config,root);
try{await adapter.start();const result=await adapter.captureScreenshotBytes({kind:'webview'});process.stdout.write(JSON.stringify({png:result.image.toString('base64')}));}
catch(error){process.stderr.write(error instanceof Error?error.message:'attach screenshot failed');process.exitCode=1;}
finally{await adapter.close();}
