import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// ────────────────────────────────────────────────
// 1. RENDER HEALTH CHECK SERVER
// ────────────────────────────────────────────────
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is active!');
}).listen(port, '0.0.0.0');

// ────────────────────────────────────────────────
// 2. CONFIGURATION & AI SETUP
// ────────────────────────────────────────────────
const API_KEY = "AIzaSyCb6STf2hteIOyjOXk0qMht-luZoEKbyDM"; 
const TARGET_UID = "1098013";

const IS_DOCKER = process.env.IS_DOCKER === 'true' || os.platform() === 'linux';
const HEADLESS = true; // Force true for Production stability

puppeteer.use(StealthPlugin());
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const CONFIG = {
  windowSize: { width: 1280, height: 720 },
  screenshotQuality: 50, // Lower quality to save memory
  gridStabilizeMs: 12000,
  navigationTimeout: 90000 
};

const wait = ms => new Promise(r => setTimeout(r, ms));

function log(uid, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${uid}]`, ...args);
}

// ────────────────────────────────────────────────
// 3. LOGIC FUNCTIONS
// ────────────────────────────────────────────────

async function humanizedClick(page, x, y) {
  try {
    await page.mouse.down();
    await wait(100);
    await page.mouse.up();
  } catch (e) {}
}

async function solveChallenge(page, uid, depth = 0) {
  if (depth > 10) return false;
  
  let bframe;
  try {
    bframe = page.frames().find(f => f.url().includes('api2/bframe'));
    if (!bframe) { await wait(4000); return solveChallenge(page, uid, depth); }
  } catch (e) { return false; }

  try {
    await bframe.waitForSelector('.rc-imageselect-tile', { visible: true, timeout: 30000 });
    await wait(CONFIG.gridStabilizeMs);

    const screenshotPath = path.join(os.tmpdir(), `cap_${uid}.jpg`);
    const payload = await bframe.$('.rc-imageselect-payload') || bframe;
    await payload.screenshot({ path: screenshotPath, type: 'jpeg', quality: CONFIG.screenshotQuality });
    
    const base64 = await fs.readFile(screenshotPath, { encoding: 'base64' });
    await fs.unlink(screenshotPath).catch(() => {});

    const result = await model.generateContent([
      { inlineData: { mimeType: "image/jpeg", data: base64 } },
      { text: "Return ONLY numbers of tiles with the object (1-9 or 1-16). If none, return 0." }
    ]);
    const text = await result.response.text();
    const tiles = text.trim().split(/\s+/).map(Number).filter(n => n >= 1);

    if (tiles.length > 0) {
      log(uid, `AI Selected: ${tiles.join(', ')}`);
      for (const t of tiles) {
        const els = await bframe.$$('.rc-imageselect-tile');
        if (els[t - 1]) {
          const box = await els[t - 1].boundingBox();
          if (box) {
            await humanizedClick(page, box.x + box.width / 2, box.y + box.height / 2);
            await wait(2000);
          }
        }
      }
      await wait(8000); 
    }

    const verifyBtn = await bframe.$('#recaptcha-verify-button');
    if (verifyBtn) await verifyBtn.click();

    await wait(7000);
    const stillHasGrid = await bframe.$('.rc-imageselect-payload').catch(() => null);
    if (stillHasGrid) return solveChallenge(page, uid, depth + 1);

    log(uid, "🎉 Solved! Submitting...");
    const submit = await page.waitForSelector('input[name="captchac"][type="submit"]', { visible: true, timeout: 10000 });
    await submit.click();
    return true;
  } catch (err) { return false; }
}

// ────────────────────────────────────────────────
// 4. MAIN ENGINE
// ────────────────────────────────────────────────
async function startSession(uid) {
  // Stagger startup for multiple users
  await wait(Math.random() * 5000);
  log(uid, "Launching Browser...");

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: IS_DOCKER ? '/usr/bin/google-chrome-stable' : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process', // Critical for RAM
      '--disable-extensions',
      '--js-flags="--max-old-space-size=512"' // Limit memory heap
    ]
  });

  const page = (await browser.pages())[0];
  await page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

  while (true) {
    try {
      log(uid, "Navigating...");
      await page.goto(`https://radioearn.com/radio/1/?uid=${uid}`, { 
        waitUntil: 'domcontentloaded', 
        timeout: CONFIG.navigationTimeout 
      });
      
      const anchorFrame = await page.waitForFrame(f => f.url().includes('api2/anchor'), { timeout: 60000 });
      const checkbox = await anchorFrame.waitForSelector('#recaptcha-anchor', { timeout: 30000 });
      
      await wait(5000);
      await checkbox.click();
      
      await wait(12000);
      await solveChallenge(page, uid, 0);

      log(uid, "Done. Refreshing in 45s...");
      await wait(45000);

    } catch (err) {
      log(uid, `Engine Error: ${err.message.substring(0, 40)}. Refreshing...`);
      await wait(15000); 
    }
  }
}

startSession(TARGET_UID);