import type { SpeechAudioRequest, StartSpeechRequest } from '../../../shared/contracts.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleSpeechRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, pathname, sendJson, requireMethod, queryKeys, body } = ctx;

  if (pathname === '/api/speech/models') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, runtime.speech.catalog());
    return true;
  }

  const speechModel = pathname.match(/^\/api\/speech\/models\/([a-z0-9.-]{1,100})\/(download|cancel)$/);
  if (speechModel) {
    requireMethod('POST');
    queryKeys();
    await body<{}>([]);
    if (speechModel[2] === 'download') runtime.speech.download(speechModel[1]);
    else runtime.speech.cancelDownload(speechModel[1]);
    sendJson(200, runtime.speech.catalog());
    return true;
  }

  if (pathname === '/api/speech/sessions') {
    requireMethod('POST');
    queryKeys();
    const request = await body<StartSpeechRequest>(['modelId']);
    sendJson(200, await runtime.speech.start(text(request.modelId, 'speech model', 100)));
    return true;
  }

  const speechSession = pathname.match(/^\/api\/speech\/sessions\/([0-9a-f-]{36})\/(audio|finish|cancel)$/);
  if (speechSession) {
    requireMethod('POST');
    queryKeys();
    if (speechSession[2] === 'audio') {
      sendJson(200, await runtime.speech.audio(speechSession[1], await body<SpeechAudioRequest>(['pcm', 'sequence'], 95000)));
    } else {
      await body<{}>([]);
      if (speechSession[2] === 'finish') {
        sendJson(200, await runtime.speech.finish(speechSession[1]));
      } else {
        runtime.speech.cancel(speechSession[1]);
        sendJson(200, { ok: true });
      }
    }
    return true;
  }

  return false;
}
