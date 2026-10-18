// Only synthetic markers are captured. The real provider serializes every request.
export function completion(content = 'synthetic-final', tool?: string, args: unknown = {}) {
  return { id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-flash', choices: [{ index: 0,
    message: { role: 'assistant', content: tool ? null : content, reasoning_content: 'synthetic-reasoning',
      ...(tool ? { tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : {}) },
    finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}
export function response(body: any, streaming: boolean) {
  if (!streaming) return Response.json(body);
  const choice = body.choices[0];
  return new Response(`data: ${JSON.stringify({ ...body, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...choice.message,
    ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((tc: any, index: number) => ({ ...tc, index })) } : {}) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...body, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
