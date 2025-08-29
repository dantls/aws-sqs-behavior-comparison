import express from 'express';
import dotenv from 'dotenv';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
app.use(express.json());

const {
  AWS_REGION = 'us-east-1',
  STANDARD_QUEUE_URL,
  FIFO_QUEUE_URL,
  STANDARD_DLQ_URL,
  FIFO_DLQ_URL,
  PORT = 3000,
} = process.env;

if (!STANDARD_QUEUE_URL || !FIFO_QUEUE_URL) {
  console.error('Defina STANDARD_QUEUE_URL e FIFO_QUEUE_URL no .env');
  process.exit(1);
}

const sqs = new SQSClient({ region: AWS_REGION });

// Estado em memória para desenhar o "Trello"
const board = {
  standard: { received: [], processing: [], done: [], failed: [], dlq: [] },
  fifo:     { received: [], processing: [], done: [], failed: [], dlq: [] },
};
const messageRetries = new Map(); // Track retry counts
const processingErrors = new Map(); // Simulate processing failures
const sseClients = new Set();
const pushUpdate = () => {
  const payload = `data: ${JSON.stringify(board)}\n\n`;
  for (const res of sseClients) res.write(payload);
};

// Página simples estilo kanban
const page = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SQS - COMPARE Standard x FIFO</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background:#0f172a; color:#e2e8f0; }
  header { padding: 16px 24px; background:#111827; border-bottom:1px solid #334155; }
  h1 { margin:0; font-size: 18px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px; }
  .col { background:#111827; border:1px solid #334155; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; }
  .col h2 { margin: 4px 0 12px; font-size: 16px; }
  .lane { display:flex; gap: 8px; flex: 1; overflow-x: auto; }
  .list { flex:1; min-width: 140px; background:#0b1220; border:1px solid #1f2937; border-radius:10px; padding:8px; min-height:120px; }
  .list h3 { margin: 0 0 8px; font-size: 13px; color:#93c5fd; }
  .card { background:#0b1727; border:1px solid #1f2937; border-radius: 10px; padding:8px; margin-bottom:8px; }
  .muted { color:#9ca3af; font-size: 12px; }
  form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:12px; }
  input, select, button { background:#0b1220; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:8px 10px; }
  button { cursor:pointer; }
  .hint { font-size:12px; color:#a3e635; margin-top: 4px; }
  a { color:#93c5fd; }
  label { font-size: 12px; display: flex; align-items: center; gap: 4px; }
  .send-all-container { grid-column: 1 / -1; text-align: center; margin-top: 16px; }
  .send-all-btn { background:#059669; border-color:#10b981; font-weight: bold; }
</style>
</head>
<body>
<header>
  <h1>SQS - COMPARE Standard x FIFO</h1>
  <div class="muted">Send requests and see how each queue behaves (ordering and deduplication).</div>
</header>
<main>
  <div class="col">
    <h2>Standard Queue</h2>
    <div class="lane">
      <div class="list" id="std-received"><h3>Received</h3></div>
      <div class="list" id="std-processing"><h3>Processing</h3></div>
      <div class="list" id="std-done"><h3>Done</h3></div>
      <div class="list" id="std-failed"><h3>Failed</h3></div>
      <div class="list" id="std-dlq"><h3>DLQ</h3></div>
    </div>
    <form id="std-form">
      <input name="count" type="number" min="1" value="5" /> 
      <label><input name="failureRate" type="number" min="0" max="100" value="20" step="10" />% Failure Rate</label>
      <button>Queue N Messages</button>
      <div class="hint">Standard doesn't guarantee order; may have eventual duplicates.</div>
    </form>
  </div>

  <div class="col">
    <h2>FIFO Queue</h2>
    <div class="lane">
      <div class="list" id="fifo-received"><h3>Received</h3></div>
      <div class="list" id="fifo-processing"><h3>Processing</h3></div>
      <div class="list" id="fifo-done"><h3>Done</h3></div>
      <div class="list" id="fifo-failed"><h3>Failed</h3></div>
      <div class="list" id="fifo-dlq"><h3>DLQ</h3></div>
    </div>
    <form id="fifo-form">
      <input name="count" type="number" min="1" value="5" /> 
      <select name="groupId">
        <option value="group-A">group-A</option>
        <option value="group-B">group-B</option>
        <option value="group-C">group-C</option>
      </select>
      <label><input name="failureRate" type="number" min="0" max="100" value="20" step="10" />% Failure Rate</label>
      <button>Queue N Messages</button>
      <div class="hint">FIFO maintains order by <em>MessageGroupId</em> and deduplicates.</div>
    </form>
  </div>

  <div class="send-all-container">
    <button id="send-all-btn" class="send-all-btn">Send All Data (Standard + All FIFO Groups)</button>
  </div>
</main>

<script>
  const el = (id) => document.getElementById(id);

  function renderBoard(data) {
    const sections = [
      ['std-received', data.standard.received],
      ['std-processing', data.standard.processing],
      ['std-done', data.standard.done],
      ['std-failed', data.standard.failed],
      ['std-dlq', data.standard.dlq],
      ['fifo-received', data.fifo.received],
      ['fifo-processing', data.fifo.processing],
      ['fifo-done', data.fifo.done],
      ['fifo-failed', data.fifo.failed],
      ['fifo-dlq', data.fifo.dlq],
    ];
    for (const [id, list] of sections) {
      const box = el(id);
      const keep = box.querySelector('h3');
      box.innerHTML = '';
      box.appendChild(keep);
      for (const msg of list) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = \`
          <div><strong>\${msg.body}</strong></div>
          <div class="muted">id: \${msg.id}</div>
          \${msg.groupId ? '<div class="muted">group: ' + msg.groupId + '</div>' : '<div class="muted">group: standard</div>'}
          \${msg.order ? '<div class="muted">seq: ' + msg.order + '</div>' : ''}
          \${msg.retryCount ? '<div class="muted">retries: ' + msg.retryCount + '</div>' : ''}
          \${msg.error ? '<div class="muted" style="color:#ef4444">error: ' + msg.error + '</div>' : ''}
        \`;
        box.appendChild(card);
      }
    }
  }

  // SSE live updates
  const ev = new EventSource('/events');
  ev.onmessage = (e) => renderBoard(JSON.parse(e.data));

  // Forms
  el('std-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const count = Number(fd.get('count'));
    const failureRate = Number(fd.get('failureRate'));
    await fetch('/enqueue/standard', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count, failureRate }) });
  });

  el('fifo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const count = Number(fd.get('count'));
    const groupId = fd.get('groupId');
    const failureRate = Number(fd.get('failureRate'));
    await fetch('/enqueue/fifo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count, groupId, failureRate }) });
  });

  // Send All Data button
  el('send-all-btn').addEventListener('click', async () => {
    const stdCount = Number(el('std-form').querySelector('input[name="count"]').value);
    const stdFailureRate = Number(el('std-form').querySelector('input[name="failureRate"]').value);
    const fifoCount = Number(el('fifo-form').querySelector('input[name="count"]').value);
    const fifoFailureRate = Number(el('fifo-form').querySelector('input[name="failureRate"]').value);
    
    // Send to standard queue and all three FIFO groups simultaneously
    await Promise.all([
      fetch('/enqueue/standard', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count: stdCount, failureRate: stdFailureRate }) }),
      fetch('/enqueue/fifo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count: fifoCount, groupId: 'group-A', failureRate: fifoFailureRate }) }),
      fetch('/enqueue/fifo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count: fifoCount, groupId: 'group-B', failureRate: fifoFailureRate }) }),
      fetch('/enqueue/fifo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count: fifoCount, groupId: 'group-C', failureRate: fifoFailureRate }) })
    ]);
  });
</script>
</body>
</html>
`;

// SSE stream
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  sseClients.add(res);
  // envia estado inicial
  res.write(`data: ${JSON.stringify(board)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// Home
app.get('/', (req, res) => res.send(page));

// Enfileirar na Standard
app.post('/enqueue/standard', async (req, res) => {
  const count = Number(req.body?.count || 1);
  const failureRate = Number(req.body?.failureRate || 0);
  
  try {
    // Batch operations for better performance
    const batchSize = 10;
    const batches = Math.ceil(count / batchSize);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchCount = Math.min(batchSize, count - batch * batchSize);
      const entries = [];
      
      for (let i = 0; i < batchCount; i++) {
        const body = `STD-${Date.now()}-${batch * batchSize + i}`;
        entries.push({
          Id: `msg-${batch}-${i}`,
          MessageBody: body,
          MessageAttributes: {
            FailureRate: { StringValue: failureRate.toString(), DataType: 'Number' },
            Timestamp: { StringValue: new Date().toISOString(), DataType: 'String' }
          }
        });
      }
      
      if (entries.length === 1) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: STANDARD_QUEUE_URL,
          MessageBody: entries[0].MessageBody,
          MessageAttributes: entries[0].MessageAttributes
        }));
      } else {
        const { SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');
        await sqs.send(new SendMessageBatchCommand({
          QueueUrl: STANDARD_QUEUE_URL,
          Entries: entries
        }));
      }
    }
    
    res.json({ ok: true, count, batches });
  } catch (error) {
    console.error('Standard enqueue error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enfileirar na FIFO
app.post('/enqueue/fifo', async (req, res) => {
  const count = Number(req.body?.count || 1);
  const groupId = req.body?.groupId || 'group-A';
  const failureRate = Number(req.body?.failureRate || 0);
  
  try {
    const batchSize = 10;
    const batches = Math.ceil(count / batchSize);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchCount = Math.min(batchSize, count - batch * batchSize);
      const entries = [];
      
      for (let i = 0; i < batchCount; i++) {
        const body = `FIFO-${Date.now()}-${batch * batchSize + i}`;
        entries.push({
          Id: `msg-${batch}-${i}`,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: uuidv4(),
          MessageAttributes: {
            FailureRate: { StringValue: failureRate.toString(), DataType: 'Number' },
            Timestamp: { StringValue: new Date().toISOString(), DataType: 'String' }
          }
        });
      }
      
      if (entries.length === 1) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: FIFO_QUEUE_URL,
          MessageBody: entries[0].MessageBody,
          MessageGroupId: entries[0].MessageGroupId,
          MessageDeduplicationId: entries[0].MessageDeduplicationId,
          MessageAttributes: entries[0].MessageAttributes
        }));
      } else {
        const { SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');
        await sqs.send(new SendMessageBatchCommand({
          QueueUrl: FIFO_QUEUE_URL,
          Entries: entries
        }));
      }
    }
    
    res.json({ ok: true, count, groupId, batches });
  } catch (error) {
    console.error('FIFO enqueue error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simulate processing with failure and retry logic
async function processMessage(card, queueType) {
  const failureRate = card.failureRate || 0;
  const shouldFail = Math.random() * 100 < failureRate;
  
  console.log(`Processing ${card.body}: failureRate=${failureRate}%, shouldFail=${shouldFail}`);
  
  if (shouldFail) {
    const retryCount = (messageRetries.get(card.id) || 0) + 1;
    messageRetries.set(card.id, retryCount);
    card.retryCount = retryCount;
    card.error = `Processing failed (attempt ${retryCount})`;
    
    // Move to failed column
    const procIndex = board[queueType].processing.findIndex(c => c.id === card.id);
    if (procIndex !== -1) {
      board[queueType].processing.splice(procIndex, 1);
      board[queueType].failed.push(card);
      pushUpdate();
    }
    
    // After 3 retries, move to DLQ
    if (retryCount >= 3) {
      setTimeout(() => {
        const failedIndex = board[queueType].failed.findIndex(c => c.id === card.id);
        if (failedIndex !== -1) {
          board[queueType].failed.splice(failedIndex, 1);
          board[queueType].dlq.push({...card, error: 'Max retries exceeded'});
          messageRetries.delete(card.id);
          pushUpdate();
        }
      }, 2000);
    } else {
      // Retry after delay (exponential backoff)
      const delay = Math.pow(2, retryCount) * 1000;
      setTimeout(() => {
        const failedIndex = board[queueType].failed.findIndex(c => c.id === card.id);
        if (failedIndex !== -1) {
          board[queueType].failed.splice(failedIndex, 1);
          board[queueType].received.push(card);
          pushUpdate();
        }
      }, delay);
    }
    
    return false; // Processing failed
  }
  
  // Success - move to done
  setTimeout(() => {
    const procIndex = board[queueType].processing.findIndex(c => c.id === card.id);
    if (procIndex !== -1) {
      board[queueType].processing.splice(procIndex, 1);
      board[queueType].done.push(card);
      messageRetries.delete(card.id);
      pushUpdate();
    }
  }, 3000);
  
  return true; // Processing succeeded
}

// Consumidor: Standard (ordem NÃO garantida)
let stdSeq = 0;
async function consumeStandard() {
  try {
    const resp = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: STANDARD_QUEUE_URL,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 30, // Increased for retry handling
      WaitTimeSeconds: 10,
      MessageAttributeNames: ['All'],
      AttributeNames: ['ApproximateReceiveCount']
    }));
    
    if (resp.Messages?.length) {
      for (const m of resp.Messages) {
        const attrs = m.MessageAttributes || {};
        const failureRate = attrs.FailureRate ? Number(attrs.FailureRate.StringValue) : 0;
        const receiveCount = Number(m.Attributes?.ApproximateReceiveCount || 1);
        
        const card = {
          id: m.MessageId,
          body: m.Body,
          rcptHandle: m.ReceiptHandle,
          order: ++stdSeq,
          failureRate,
          retryCount: receiveCount - 1
        };
        
        board.standard.received.push(card);
        pushUpdate();

        // Move to processing after 1 second
        setTimeout(() => {
          const index = board.standard.received.findIndex(c => c.id === card.id);
          if (index !== -1) {
            board.standard.received.splice(index, 1);
            board.standard.processing.push(card);
            pushUpdate();
            
            // Process with failure simulation
            processMessage(card, 'standard').then(success => {
              if (success) {
                // Delete from SQS on success
                sqs.send(new DeleteMessageCommand({
                  QueueUrl: STANDARD_QUEUE_URL,
                  ReceiptHandle: m.ReceiptHandle,
                })).catch(console.error);
              }
              // On failure, message will become visible again for retry
            });
          }
        }, 1000);
      }
    }
  } catch (e) {
    console.error('Standard consumer error:', e.message);
    // Exponential backoff on errors
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.pow(2, 5) * 1000)));
  } finally {
    setImmediate(consumeStandard);
  }
}

// Consumidor: FIFO (ordem por MessageGroupId garantida)
let fifoSeq = 0;
async function consumeFifo() {
  try {
    const resp = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: FIFO_QUEUE_URL,
      MaxNumberOfMessages: 1, // FIFO processes one at a time per group
      VisibilityTimeout: 30,
      WaitTimeSeconds: 10,
      AttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
      MessageAttributeNames: ['All']
    }));
    
    if (resp.Messages?.length) {
      for (const m of resp.Messages) {
        const attrs = m.MessageAttributes || {};
        const failureRate = attrs.FailureRate ? Number(attrs.FailureRate.StringValue) : 0;
        const groupId = m.Attributes?.MessageGroupId;
        const receiveCount = Number(m.Attributes?.ApproximateReceiveCount || 1);
        
        const card = {
          id: m.MessageId,
          body: m.Body,
          rcptHandle: m.ReceiptHandle,
          groupId,
          order: ++fifoSeq,
          failureRate,
          retryCount: receiveCount - 1
        };
        
        board.fifo.received.push(card);
        pushUpdate();

        // Move to processing after 1 second
        setTimeout(() => {
          const index = board.fifo.received.findIndex(c => c.id === card.id);
          if (index !== -1) {
            board.fifo.received.splice(index, 1);
            board.fifo.processing.push(card);
            pushUpdate();
            
            // Process with failure simulation
            processMessage(card, 'fifo').then(success => {
              if (success) {
                // Delete from SQS on success
                sqs.send(new DeleteMessageCommand({
                  QueueUrl: FIFO_QUEUE_URL,
                  ReceiptHandle: m.ReceiptHandle,
                })).catch(console.error);
              }
              // On failure, message will become visible again for retry
            });
          }
        }, 1000);
      }
    }
  } catch (e) {
    console.error('FIFO consumer error:', e.message);
    // Exponential backoff on errors
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.pow(2, 5) * 1000)));
  } finally {
    setImmediate(consumeFifo);
  }
}

consumeStandard();
consumeFifo();

app.listen(PORT, () => {
  console.log(`App em http://localhost:${PORT}`);
});
