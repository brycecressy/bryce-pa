require('dotenv').config();
const { App } = require('@slack/bolt');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

let savedChannel = null;

async function getSheetClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getTasks() {
  const sheets = await getSheetClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Tasks!A2:G',
  });
  return (res.data.values || []).map((row, i) => ({
    rowIndex: i + 2,
    id: row[0] || '',
    task: row[1] || '',
    status: row[2] || 'Open',
    dueDate: row[3] || '',
    lastPrompted: row[4] || '',
    nextAction: row[5] || '',
    notes: row[6] || '',
  }));
}

async function appendTask(task) {
  console.log('?? Saving task to sheet:', task.task);
  const sheets = await getSheetClient();
  const id = Date.now().toString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Tasks!A:G',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[id, task.task, 'Open', task.dueDate || '', new Date().toISOString(), task.nextAction || '', task.notes || '']],
    },
  });
  console.log('? Task saved with id:', id);
  return id;
}

async function updateTask(rowIndex, updates) {
  const sheets = await getSheetClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Tasks!A${rowIndex}:G${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[updates.id, updates.task, updates.status, updates.dueDate, new Date().toISOString(), updates.nextAction, updates.notes]],
    },
  });
}

async function processWithClaude(userMessage, tasks) {
  console.log('?? Sending to Claude:', userMessage);
  const taskSummary = tasks
    .filter(t => t.status !== 'Done')
    .map(t => `[${t.id}] ${t.task} | Status: ${t.status} | Due: ${t.dueDate || 'none'} | Next: ${t.nextAction}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are Bryce's personal PA bot on Slack. Help him capture tasks and stay on top of commitments. Be concise and direct.

When he sends a message:
1. New task/reminder ? extract task name, due date, next action
2. Status update ? identify which task and update it
3. "Done" ? mark it done
4. Confirm what you did and ask one follow-up if useful

Current open tasks:
${taskSummary || 'No open tasks yet.'}

Respond in JSON only — no markdown, no code blocks, just raw JSON:
{"reply":"your reply","action":"new_task","taskData":{"task":"","dueDate":"","nextAction":"","notes":"","status":"Open"},"updateTaskId":""}`,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim();
  console.log('?? Claude raw response:', raw);
  try {
    return JSON.parse(raw);
  } catch {
    return { reply: raw, action: 'no_action' };
  }
}

async function morningBriefing() {
  if (!savedChannel) return;
  const tasks = await getTasks();
  const today = new Date().toISOString().split('T')[0];
  const openTasks = tasks.filter(t => t.status !== 'Done');
  const overdue = openTasks.filter(t => t.dueDate && t.dueDate < today);
  const dueToday = openTasks.filter(t => t.dueDate === today);
  const noUpdate = openTasks.filter(t => {
    if (!t.lastPrompted) return true;
    return (Date.now() - new Date(t.lastPrompted)) / (1000 * 60 * 60 * 24) > 3;
  });

  let msg = `?? Morning Bryce — here's your rundown:\n\n`;
  if (overdue.length) msg += `?? *Overdue (${overdue.length}):*\n${overdue.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (dueToday.length) msg += `?? *Due today (${dueToday.length}):*\n${dueToday.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (noUpdate.length) msg += `?? *No update in 3+ days (${noUpdate.length}):*\n${noUpdate.map(t => `• ${t.task}`).join('\n')}\n\n`;
  if (!overdue.length && !dueToday.length && !noUpdate.length) msg += `? All clear!\n\n`;
  msg += `Reply with updates or drop new tasks here.`;

  await app.client.chat.postMessage({ channel: savedChannel, text: msg });
  for (const t of [...overdue, ...dueToday, ...noUpdate]) {
    await updateTask(t.rowIndex, { ...t, lastPrompted: new Date().toISOString() });
  }
}

app.message(async ({ message, say }) => {
  console.log('?? Message received:', message.text);
  if (message.bot_id || message.subtype) return;
  savedChannel = message.channel;

  try {
    const tasks = await getTasks();
    const result = await processWithClaude(message.text, tasks);

    if (result.action === 'new_task' && result.taskData?.task) {
      await appendTask(result.taskData);
    } else if (result.action === 'update_task' && result.updateTaskId) {
      const task = tasks.find(t => t.id === result.updateTaskId);
      if (task) await updateTask(task.rowIndex, { ...task, ...result.taskData });
    }

    await say(result.reply);
  } catch (err) {
    console.error('? Error:', err.message);
    await say('Something went wrong — ' + err.message);
  }
});

cron.schedule('0 5 * * *', morningBriefing);

(async () => {
  await app.start();
  console.log('? Bryce PA bot running on Slack');
})();


