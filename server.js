import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────
const API_KEY = "AIzaSyCb6STf2hteIOyjOXk0qMht-luZoEKbyDM"; 
const TARGET_UID = "1098013";

// AUTO-DETECT ENVIRONMENT
const IS_DOCKER = process.env.IS_DOCKER === 'true' || os.platform() === 'linux';
const HEADLESS = IS_DOCKER ? true : false; // Visual on Local, Hidden on Prod

puppeteer.use(StealthPlugin());

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  safetySettings: [
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  ],
});

const CONFIG = {
  windowSize: { width: 1280, height: 720 },
  screenshotQuality: 60,
  minDelayAfterClick: 2500,
  gridStabilizeMs: 8000,
  navigationTimeout: 90000,
};

const wait = ms => new Promise(r => setTimeout(r, ms));

function log(uid, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${uid}] ${IS_DOCKER ? '(PROD)' : '(LOCAL)'}`, ...args);
}

// ────────────────────────────────────────────────
// LOGIC (solveChallenge and humanizedClick)
// ────────────────────────────────────────────────

async function humanizedClick(page, x, y) {
  try {
    if (!IS_DOCKER) await page.mouse.move(x - 5, y - 5, { steps: 5 });
    await page.mouse.down();
    await wait(150);
    await page.mouse.up();
  } catch (e) {}
}

async function solveChallenge(page, uid, depth = 0) {
  if (depth > 12) return false;
  let bframe;
  try {
    bframe = page.frames().find(f => f.url().includes('api2/bframe'));
    if (!bframe) { await wait(3000); return solveChallenge(page, uid, depth); }
  } catch (e) { return solveChallenge(page, uid, depth); }

  try {
    await bframe.waitForSelector('.rc-imageselect-tile', { visible: true, timeout: 30000 });
    log(uid, `Grid stabilized. Analyzing...`);
    await wait(CONFIG.gridStabilizeMs);

    const screenshotPath = path.join(os.tmpdir(), `cap_${uid}.jpg`);
    const payload = await bframe.$('.rc-imageselect-payload') || bframe;
    await payload.screenshot({ path: screenshotPath, type: 'jpeg', quality: CONFIG.screenshotQuality });
    const base64 = await fs.readFile(screenshotPath, { encoding: 'base64' });
    await fs.unlink(screenshotPath).catch(() => {});

    let text;
    try {
      const result = await model.generateContent([
        { inlineData: { mimeType: "image/jpeg", data: base64 } },
        { text: "Return ONLY numbers of tiles with the object (1-9 or 1-16). If none, return 0." }
      ]);
      text = await result.response.text();
    } catch (apiErr) {
      if (apiErr.message.includes("429")) {
        log(uid, "⚠️ Quota hit. Waiting 60s...");
        await wait(60000);
        return solveChallenge(page, uid, depth);
      }
      throw apiErr;
    }

    const tiles = text.trim().split(/\s+/).map(Number).filter(n => n >= 1);
    if (tiles.length > 0) {
      log(uid, `AI Selected: ${tiles.join(', ')}`);
      for (const t of tiles) {
        const els = await bframe.$$('.rc-imageselect-tile');
        if (els[t - 1]) {
          const box = await els[t - 1].boundingBox();
          if (box) {
            await humanizedClick(page, box.x + box.width / 2, box.y + box.height / 2);
            await wait(CONFIG.minDelayAfterClick);
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

    log(uid, "🎉 Solved. Submitting form...");
    await wait(4000);
    const submit = await page.waitForSelector('input[name="captchac"][type="submit"]', { visible: true, timeout: 15000 });
    await submit.click();
    return true;
  } catch (err) {
    log(uid, `Round failed: ${err.message.substring(0, 50)}`);
    return false; 
  }
}

// ────────────────────────────────────────────────
// MAIN ENGINE
// ────────────────────────────────────────────────
async function startSession(uid) {
  log(uid, "Initializing Browser...");

  const launchArgs = {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
    defaultViewport: CONFIG.windowSize
  };

  // Only apply Linux path if we are in Docker
  if (IS_DOCKER) {
    launchArgs.executablePath = '/usr/bin/google-chrome-stable';
  }

  const browser = await puppeteer.launch(launchArgs);
  const page = (await browser.pages())[0];
  await page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

  while (true) {
    try {
      log(uid, "Navigating to URL...");
      await page.goto(`https://radioearn.com/radio/1/?uid=${uid}`, { waitUntil: 'networkidle2' });
      
      const anchorFrame = await page.waitForFrame(f => f.url().includes('api2/anchor'), { timeout: 45000 });
      const checkbox = await anchorFrame.waitForSelector('#recaptcha-anchor', { timeout: 30000 });
      
      await wait(3000);
      await checkbox.click();
      log(uid, "Checkbox clicked ✓");
      
      await wait(10000);
      await solveChallenge(page, uid, 0);

      log(uid, "Session Active. Refreshing in 30s...");
      await wait(30000);

    } catch (err) {
      log(uid, `Error: ${err.message.substring(0, 60)}. Refreshing...`);
      await wait(10000); 
    }
  }
}

startSession(TARGET_UID);