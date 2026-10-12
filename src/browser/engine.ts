import { chromium, firefox, webkit, type BrowserType } from 'playwright';

export type BrowserEngine='chromium'|'firefox'|'webkit';
const browserTypes:Record<BrowserEngine,BrowserType>={chromium,firefox,webkit};

export function browserTypeFor(engine:BrowserEngine|string|undefined):BrowserType {
 const selected=engine??'chromium';
 if(selected!=='chromium'&&selected!=='firefox'&&selected!=='webkit')throw Error(`Unsupported browser engine: ${selected}`);
 return browserTypes[selected];
}
