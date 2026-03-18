require('dotenv').config();
const http = require('http');
const { App } = require('@slack/bolt');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });

http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

let savedChannel = null;
const conversationHistory = [];

async function getSheetClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function getTasks() {
  const sheets = await getSheetClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Tasks!A2:H' });
  return (res.data.values || []).map((row, i) => ({
    rowIndex: i + 2, id: row[0] || '', task: row[1] || '', status: row[2] || 'Open',
    dueDate: row[3] || '', lastPrompted: row[4] || '', nextAction: row[5] || '',
    notes: row[6] || '', reminderTime: row[7] || '',
  }));
}

async function appendTask(task) {
  console.log('Saving:', task.task);
  const sheets = await getSheetClient();
  const id = Date.now().toString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Tasks!A:H', valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[id, task.task, 'Open', task.dueDate || '', new Date().toISOString(), task.nextAction || '', task.notes || '', task.reminderTime || '']] },
  });
  return id;
}

async function updateTask(rowIndex, updates) {
  const sheets = await getSheetClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `Tasks!A${rowIndex}:H${rowIndex}`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[updates.id, updates.task, updates.status, updates.dueDate, new Date().toISOString(), updates.nextAction, updates.notes, updates.reminderTime || '']] },
  });
}

async function processWithClaude(userMessage, tasks) {
  const now = new Date();
  const saTime = now.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
  const saDate = now.toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' });

  const taskSummary = tasks.filter(t => t.status !== 'Done')
    .map(t => `[${t.id}] ${t.task} | ${t.status} | Due: ${t.dueDate || 'none'} | Reminder: ${t.reminderTime || 'none'}`)
    .join('\n');

  const systemPrompt = `You are Bryce's PA bot on Slack. Capture tasks, track follow-ups, stay concise and direct.

Current SA time: ${saTime}
Current SA date: ${saDate}

When he sends a message:
1. New task - extract name, due date, next action, reminder time (24hr HH:MM format if mentioned, calculate from current time if he says "in X minutes")
2. Status update - find and update the task
3. "Done" - mark done
4. Confirm what you did, ask one follow-up if useful

Open tasks:
${taskSummary || 'None yet.'}

Reply in raw JSON only, absolutely no markdown or code blocks:
{"reply":"your plain text reply","action":"new_task or update_task or no_action","taskData":{"task":"","dueDate":"","nextAction":"","notes":"","status":"Open","reminderTime":""},"updateTaskId":""}`;

  conversationHistory.push({ role: 'user', content: userMessage });
  if (conversationHistory.length > 10) conversationHistory.splice(0, 2);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1024,
    system: systemPrompt,
    messages: conversationHistory,
  });

  const raw = response.content[0].text.trim();
  console.log('Claude:', raw);

  try {
    const parsed = JSON.parse(raw);
    conversationHistory.push({ role: 'assistant', content: raw });
    return parsed;
  } catch {
    conversationHistory.push({ role: 'assistant', content: raw });
    return { reply: raw, action: 'no_action' };
  }
}

async function morningBriefing() {
  if (!savedChannel) return;
  const tasks = await getTasks();
  const today = new Date().toISOString().split('T')[0];
  const open = tasks.filter(t => t.status !== 'Done');
  const overdue = open.filter(t => t.dueDate && t.dueDate < today);
  const dueToday = open.filter(t => t.dueDate === today);
  const stale = open.filter(t => !t.lastPrompted || (Date.now() - new Date(t.lastPrompted)) / 86400000 > 3);

  let msg = `☀️ Morning Bryce — here's your rundown:\n\n`;
  if (overdue.length) msg += `🔴 *Overdue:*\n${overdue.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (dueToday.length) msg += `📅 *Due today:*\n${dueToday.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (stale.length) msg += `💬 *No update in 3+ days:*\n${stale.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (!overdue.length && !dueToday.length && !stale.length) msg += `✅ All clear!\n\n`;
  msg += `Reply with updates or new tasks.`;

  await app.client.chat.postMessage({ channel: savedChannel, text: msg });
  for (const t of [...new Set([...overdue, ...dueToday, ...stale])])
    await updateTask(t.rowIndex, { ...t, lastPrompted: new Date().toISOString() });
}

cron.schedule('* * * * *', async () => {
  if (!savedChannel) return;
  try {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
    const tasks = await getTasks();
    const due = tasks.filter(t => t.reminderTime === currentTime && t.status !== 'Done');
    for (const t of due) {
      await app.client.chat.postMessage({ channel: savedChannel, text: `⏰ Reminder: *${t.task}*\nDone, or follow up later?` });
      await updateTask(t.rowIndex, { ...t, reminderTime: '', lastPrompted: new Date().toISOString() });
    }
  } catch (e) { console.error('Reminder error:', e.message); }
});

cron.schedule('0 5 * * *', morningBriefing);

app.message(async ({ message, say }) => {
  console.log('Received:', message.text);
  if (message.bot_id || message.subtype) return;
  savedChannel = message.channel;
  try {
    const tasks = await getTasks();
    const result = await processWithClaude(message.text, tasks);
    if (result.action === 'new_task' && result.taskData && result.taskData.task) await appendTask(result.taskData);
    else if (result.action === 'update_task' && result.updateTaskId) {
      const task = tasks.find(t => t.id === result.updateTaskId);
      if (task) await updateTask(task.rowIndex, { ...task, ...result.taskData });
    }
    await say(result.reply);
  } catch (err) {
    console.error('Error:', err.message);
    await say('Something went wrong — ' + err.message);
  }
});

(async () => {
  await app.start();
  console.log('Bryce PA bot running');
})();