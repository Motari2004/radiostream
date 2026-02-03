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
  res.end('Bot is active and playing!');
}).listen(port, '0.0.0.0');

// ────────────────────────────────────────────────
// 2. CONFIGURATION & AI SETUP
// ────────────────────────────────────────────────
const API_KEY = "AIzaSyBySegrwBbDdVZEe2Dew7S7PzJGl2vwFho"; 
const TARGET_UID = "1098013";
const LOCAL_HEADLESS = false; // Set to true if you want local to be hidden too

const IS_DOCKER = process.env.IS_DOCKER === 'true' || os.platform() === 'linux';
const FINAL_HEADLESS = IS_DOCKER ? true : LOCAL_HEADLESS;

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
  windowSize: { width: 820, height: 720 },
  screenshotQuality: 58,
  minDelayAfterClick: 2200,
  gridStabilizeMs: 7200,
  maxRecursionDepth: 12,
  postVerifyWaitMs: 3500,
  audioWaitTimeoutMs: 30000,
  navigationTimeout: 90000
};

const wait = ms => new Promise(r => setTimeout(r, ms));

function log(uid, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  const env = IS_DOCKER ? 'PROD' : 'LOCAL';
  console.log(`[${ts}] [${uid}] (${env})`, ...args);
}

// ────────────────────────────────────────────────
// 3. HUMANIZED MOVEMENT & TILE LOGIC
// ────────────────────────────────────────────────

async function humanizedClick(page, x, y) {
  // Movement is only useful/visible in non-headless mode
  if (!FINAL_HEADLESS) {
    await page.mouse.move(x - 28, y - 22, { steps: 7 + Math.floor(Math.random() * 6) });
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 5) });
  }
  await page.mouse.down();
  await wait(55 + Math.random() * 120);
  await page.mouse.up();
}

async function clickTile(bframe, targetTileNumber, page, uid) {
  try {
    const tiles = await bframe.$$('.rc-imageselect-tile');
    if (tiles.length === 0 || tiles.length < targetTileNumber) return false;

    const tileEl = tiles[targetTileNumber - 1];
    const box = await tileEl.boundingBox();
    if (!box) return false;

    const clickX = box.x + box.width * (0.38 + Math.random() * 0.24);
    const clickY = box.y + box.height * (0.38 + Math.random() * 0.24);

    log(uid, `→ clicking tile ${targetTileNumber} @ (${Math.round(clickX)},${Math.round(clickY)})`);
    await humanizedClick(page, clickX, clickY);
    await wait(CONFIG.minDelayAfterClick + Math.random() * 1200);
    return true;
  } catch (err) {
    return false;
  }
}

// ────────────────────────────────────────────────
// 4. VERIFICATION LOGIC
// ────────────────────────────────────────────────

async function solveChallenge(page, uid, depth = 0) {
  if (depth > CONFIG.maxRecursionDepth) return false;

  let bframe = page.frames().find(f => f.url().includes('api2/bframe'));
  if (!bframe) {
    await wait(3000);
    bframe = page.frames().find(f => f.url().includes('api2/bframe'));
    if (!bframe) return false;
  }

  try {
    await bframe.waitForSelector('.rc-imageselect-tile', { visible: true, timeout: 20000 });
    const tileCount = await bframe.$$eval('.rc-imageselect-tile', els => els.length);
    
    log(uid, `Grid: ${tileCount} tiles (round ${depth + 1})`);
    await wait(CONFIG.gridStabilizeMs);

    const screenshotPath = path.join(os.tmpdir(), `cap_${uid}_${Date.now()}.jpg`);
    const payload = await bframe.$('.rc-imageselect-payload') || bframe;
    await payload.screenshot({ path: screenshotPath, type: 'jpeg', quality: CONFIG.screenshotQuality });

    const base64 = await fs.readFile(screenshotPath, { encoding: 'base64' });
    await fs.unlink(screenshotPath).catch(() => {});

    const prompt = `Return ONLY space-separated numbers of tiles (1-${tileCount}) containing the object.`;
    const result = await model.generateContent([
      { inlineData: { mimeType: "image/jpeg", data: base64 } },
      { text: prompt }
    ]);

    const text = await result.response.text();
    const tiles = text.trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= tileCount);

    if (tiles.length > 0) {
      log(uid, `Gemini selected: ${tiles.join(', ')}`);
      for (const tile of tiles) {
        await clickTile(bframe, tile, page, uid);
      }
      await wait(2000);
    }

    const verifyBtn = await bframe.$('#recaptcha-verify-button');
    if (verifyBtn) {
      const vBox = await verifyBtn.boundingBox();
      vBox ? await humanizedClick(page, vBox.x + vBox.width/2, vBox.y + vBox.height/2) : await verifyBtn.click();
    }

    // Visual Tick Verification
    await wait(CONFIG.postVerifyWaitMs);
    const checkPath = path.join(os.tmpdir(), `check_${uid}.jpg`);
    await page.screenshot({ path: checkPath, type: 'jpeg', quality: 60 });
    const checkBase64 = await fs.readFile(checkPath, { encoding: 'base64' });
    await fs.unlink(checkPath).catch(() => {});

    const checkResult = await model.generateContent([
      { inlineData: { mimeType: "image/jpeg", data: checkBase64 } },
      { text: "Is there a green tick/checkmark in the reCAPTCHA box? Answer ONLY YES or NO." }
    ]);
    
    if ((await checkResult.response.text()).toUpperCase().includes("YES")) {
      log(uid, "🎉 AI confirmed green tick!");
      const submitBtn = await page.waitForSelector('input[name="captchac"][type="submit"]', { visible: true, timeout: 10000 });
      const sBox = await submitBtn.boundingBox();
      sBox ? await humanizedClick(page, sBox.x + sBox.width/2, sBox.y + sBox.height/2) : await submitBtn.click();
      
      // Confirm Radio
      return await waitForRadioAudio(page, uid);
    }

    // Recurse if grid still exists
    const stillHasGrid = await bframe.$('.rc-imageselect-payload').catch(() => null);
    if (stillHasGrid) return solveChallenge(page, uid, depth + 1);
    
    return false;
  } catch (err) {
    log(uid, "solveChallenge error:", err.message.substring(0, 50));
    return false;
  }
}

async function waitForRadioAudio(page, uid) {
  try {
    await page.waitForSelector('#rearn', { visible: true, timeout: CONFIG.audioWaitTimeoutMs });
    log(uid, "=== RADIO PLAYER DETECTED - SUCCESS ===");
    return true;
  } catch (e) { return false; }
}

// ────────────────────────────────────────────────
// 5. MAIN ENGINE
// ────────────────────────────────────────────────
async function startSession(uid) {
  log(uid, `Launching (Headless: ${FINAL_HEADLESS})`);

  const browser = await puppeteer.launch({
    headless: FINAL_HEADLESS,
    executablePath: IS_DOCKER ? '/usr/bin/google-chrome-stable' : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      IS_DOCKER ? '--single-process' : '',
      '--window-size=820,720'
    ].filter(Boolean)
  });

  const page = (await browser.pages())[0];
  await page.setViewport({ width: 820, height: 720 });

  while (true) {
    try {
      log(uid, "Navigating...");
      await page.goto(`https://radioearn.com/radio/1/?uid=${uid}`, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeout });
      
      const anchorFrame = await page.waitForFrame(f => f.url().includes('api2/anchor'), { timeout: 45000 });
      const checkbox = await anchorFrame.waitForSelector('#recaptcha-anchor', { timeout: 20000 });
      
      await wait(3000);
      await checkbox.click();
      log(uid, "Checkbox clicked ✓");
      
      await wait(10000);
      await solveChallenge(page, uid, 0);

      log(uid, "Cycle finished. Sleeping 60s...");
      await wait(60000);
    } catch (err) {
      log(uid, `Loop error: ${err.message.substring(0, 40)}. Restarting...`);
      await wait(10000);
    }
  }
}

startSession(TARGET_UID);