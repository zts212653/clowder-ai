// Protocol fixture for the real SDK. It never calls a model or writes sessions.
if (process.argv.includes('--version')) {
  console.log('2.1.312 (Claude Code)');
} else {
  const readline = require('node:readline');
  const session = '6bc154f6-d6ed-4ad9-9dbe-3a5fc96712ee';
  const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const event = JSON.parse(line);
    if (event.type === 'control_request') {
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: event.request_id,
          response: {
            commands: [],
            models: [{ value: 'claude-fixture', displayName: 'Fixture', description: 'Protocol fixture' }],
            account: {},
            output_style: 'default',
          },
        },
      });
    } else if (event.type === 'user') {
      send({ type: 'system', subtype: 'init', session_id: session, model: 'fixture', tools: [] });
      send({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: session });
      send({
        type: 'assistant',
        session_id: session,
        message: {
          id: 'external-fixture',
          role: 'assistant',
          content: [{ type: 'text', text: 'external-runtime-used' }],
        },
      });
      send({
        type: 'result',
        subtype: 'success',
        session_id: session,
        result: 'external-runtime-used',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        user_message_uuids: [event.uuid],
        queued_turn_count: 0,
      });
      send({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: session });
    }
  });
}
