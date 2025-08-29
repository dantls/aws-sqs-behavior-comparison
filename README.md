# SQS Standard vs FIFO Queue Comparison

A visual demonstration tool comparing AWS SQS Standard and FIFO queues with Dead Letter Queue (DLQ) handling.

## Features

- **Real-time Kanban Board**: Visual representation of message flow through different stages
- **Queue Comparison**: Side-by-side comparison of Standard vs FIFO queue behavior
- **Message Processing Simulation**: Configurable failure rates to test error handling
- **Dead Letter Queue Support**: Automatic retry and DLQ routing for failed messages
- **Live Updates**: Server-Sent Events (SSE) for real-time UI updates

## Prerequisites

- Node.js
- AWS Account with SQS access
- AWS CLI configured or environment variables set

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```
AWS_REGION=us-east-1
STANDARD_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/standard-queue
FIFO_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/fifo-queue.fifo
STANDARD_DLQ_URL=https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/standard-dlq
FIFO_DLQ_URL=https://sqs.us-east-1.amazonaws.com/YOUR_ACCOUNT/fifo-dlq.fifo
PORT=3000
```

3. Create SQS queues and DLQs (if using the provided script):
```bash
./create-dlq.sh
```

## Usage

1. Start the server:
```bash
node server.js
```

2. Open browser to `http://localhost:3000`

3. Use the interface to:
   - Queue messages to Standard or FIFO queues
   - Set failure rates to simulate processing errors
   - Watch messages move through: Received → Processing → Done/Failed → DLQ

## Queue Behavior Differences

### Standard Queue
- **Ordering**: Best-effort ordering, no guarantee
- **Delivery**: At-least-once delivery (possible duplicates)
- **Throughput**: Nearly unlimited
- **Use Case**: High throughput, order not critical

### FIFO Queue
- **Ordering**: Strict FIFO within MessageGroupId
- **Delivery**: Exactly-once processing
- **Throughput**: Up to 300 TPS (3000 with batching)
- **Use Case**: Order critical, no duplicates

## API Endpoints

- `GET /` - Web interface
- `GET /events` - SSE stream for real-time updates
- `POST /enqueue/standard` - Queue messages to standard queue
- `POST /enqueue/fifo` - Queue messages to FIFO queue
- `POST /process` - Manually trigger message processing

## Message Flow

1. **Received**: Messages arrive in queue
2. **Processing**: Messages being processed (simulated delay)
3. **Done**: Successfully processed messages
4. **Failed**: Messages that failed processing (will retry)
5. **DLQ**: Messages that exceeded retry limit
