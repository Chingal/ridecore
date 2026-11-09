import { App } from 'aws-cdk-lib';
import { StatefulStack } from './stateful-stack.ts';

const app = new App();
new StatefulStack(app, 'RidecoreStateful', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
