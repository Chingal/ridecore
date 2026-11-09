import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Low-level client; points at `AWS_ENDPOINT_URL` (Floci) when set, otherwise the default AWS endpoint. */
export function createDynamoClient(env: NodeJS.ProcessEnv = process.env): DynamoDBClient {
  const endpoint = env.AWS_ENDPOINT_URL;
  return new DynamoDBClient(endpoint ? { endpoint } : {});
}

export function createDocumentClient(client: DynamoDBClient = createDynamoClient()): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
