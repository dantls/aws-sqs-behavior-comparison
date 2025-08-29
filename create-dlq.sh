#!/bin/bash

# Create Standard DLQ
aws sqs create-queue \
  --queue-name challenge5-standard-dlq \
  --region us-east-1

# Create FIFO DLQ
aws sqs create-queue \
  --queue-name challenge5-fifo-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --region us-east-1

# Get DLQ ARNs
STANDARD_DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/219315608868/challenge5-standard-dlq \
  --attribute-names QueueArn \
  --region us-east-1 \
  --query 'Attributes.QueueArn' \
  --output text)

FIFO_DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/219315608868/challenge5-fifo-dlq.fifo \
  --attribute-names QueueArn \
  --region us-east-1 \
  --query 'Attributes.QueueArn' \
  --output text)

# Configure main queues with DLQ redrive policy
aws sqs set-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/219315608868/challenge5-standard-queue \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$STANDARD_DLQ_ARN\\\",\\\"maxReceiveCount\\\":3}\"}" \
  --region us-east-1

aws sqs set-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/219315608868/challenge5-fifo-queue.fifo \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$FIFO_DLQ_ARN\\\",\\\"maxReceiveCount\\\":3}\"}" \
  --region us-east-1

echo "DLQ setup complete!"
echo "Standard DLQ ARN: $STANDARD_DLQ_ARN"
echo "FIFO DLQ ARN: $FIFO_DLQ_ARN"
