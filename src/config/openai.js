const OpenAI = require('openai');
const env = require('./env');

let client = null;

function getOpenAIClient() {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

function resolveOpenAIModel(modelId = 'max') {
  return modelId === 'fast' ? env.OPENAI_MODEL_FAST : env.OPENAI_MODEL_MAX;
}

module.exports = { getOpenAIClient, resolveOpenAIModel };
