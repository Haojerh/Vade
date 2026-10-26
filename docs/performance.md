# UI resource lifecycle

Resource Manager requests process details only while its popover is open and the page is visible. The bottom RAM indicator keeps its bounded five-second summary refresh. Summary scans collect PID, parent PID and working-set bytes; detailed scans additionally collect process names, command lines, CPU and private-memory metadata. A fresh detailed snapshot can serve a summary request without another scan. Port ownership checks still request the process metadata they need.

Hidden terminal surfaces withhold output acknowledgement credit instead of disconnecting their input socket. The server can retain at most one bounded unacknowledged output page for that view; the owned PTY and headless screen continue running. Returning processes that page, claims visible geometry and resumes credit. No keyboard input, launch, resume or approval is replayed on visibility changes. Unmounting still disposes the socket, xterm, touch handlers, timers and observers. Unexpected connection failures still require explicit Reconnect.

Project snapshot streams pause when the document is hidden. Automatic Kanban is an explicit exception: its observations remain active so background queue dispatch keeps working. Conversation streaming pauses when Chat is replaced by Terminal and retains its exact source-bound forward cursor. GitHub, prerequisites, resource detail, voice-download progress and graph-animation work skip hidden pages. Speech capture, autosave and backend agent execution are not suspended by presentation visibility.

Settings sections, commit history and conversation rendering load on demand. Monaco and rich Markdown editors retain their existing lazy loading and unsaved-change handling.

Long conversation and activity histories use browser-managed rendering virtualization after 80 rows. Real content heights are measured before offscreen rendering is suppressed; existing nodes and disclosure state remain mounted. This intentionally preserves browser Find, selection, accessibility and recorded text. It reduces layout/paint work, rather than evicting loaded messages from memory. Unsupported browsers keep the ordinary rendering path. Response controls remain outside containment, and row replacement and disposal release observers.

Local speech retains its existing 60-second idle unload. The idle callback now verifies the worker identity, absence of a recording and absence of pending inference before destroying the worker. Downloaded models remain on disk.

## Verification

- Browser fixture compares released commit `f5a36b9` and current components with the same mock agent, 100 ms output cadence and 250 variable-height messages. No real agent receives input.
- Closed Resource Manager: the released fixture issued periodic detail requests (8 observed over approximately 38 seconds); the updated fixture issued zero. Opening fetched details, and closing stopped further requests.
- Hidden terminal: released code continued acknowledging hundreds of output pages. Updated code settled at one outstanding page (70 sent / 69 acknowledged), with no further pages during the hidden interval. Returning resumed output on the same connection. Four typed input events remained four after hide/show, with no process resume calls.
- Terminal disposal removed xterm and stopped output; remount created one new connection. Long history retained 250 messages, supported expansion, and preserved a tool disclosure across scrolling.
- Lightweight Windows process snapshots serialized approximately 19 KB instead of 165 KB on this machine. Wall-clock scans varied under concurrent builds; no scan-time speedup is claimed.
- Initial application JavaScript fell from 943,279 bytes to approximately 852 KB (about 9.7%). Editor workers remain separate deferred assets.
- Browser heap readings and first-mount timings were noisy. No whole-application CPU/RAM percentage improvement or installed-app startup speedup is claimed. Those require a controlled installed-build comparison with the same live agents. Real iPhone hardware and minimized native windows were not available for verification.

Regression coverage includes stream pause/replacement/cleanup, retained forward cursors, Automatic Kanban background observation, real-height row tracking, observer disposal, speech idle fencing and lightweight resource scan caching. Browser rendering behavior follows [content-visibility auto](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility).
