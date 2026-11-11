import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    AGENT_RUN_TERMINAL_EVENT,
    type AgentRunTerminalEvent,
} from '../database/agent-run-terminal.event';
import { ATTENTION_REASON_QUEUED_TOO_LONG } from '../database/repositories/agent-run.repository';
import { AgentEscalationService } from './agent-escalation.service';

/**
 * A `queued-too-long` escalation closes itself when its run ends.
 *
 * The sweeper files that card while the run is still queued ("raise the
 * limit, cancel, or keep waiting?"). Once the run has ended — completed,
 * failed or cancelled, through any path — the question is moot, and before
 * this the card stayed open until a person resolved it by hand: weeks-old
 * "queued for 143 minutes" cards on the dashboard for runs that had long
 * since failed.
 *
 * Only runs the sweeper flagged (`attentionReason = 'queued-too-long'`) are
 * looked at, so every other terminal run costs nothing here. The close itself
 * is the escalation service's system path: no user id, a fixed note, the
 * Inbox mirror closed, nothing resumed. Manual resolution keeps requiring a
 * signed-in person. `AgentEscalationService.closeEndedQueuedTooLong` (run by
 * the sweeper) is the backstop for cards this listener never saw.
 *
 * Best-effort by contract: the service never throws, and a failure here can
 * never touch the terminal write that raised the event. Synchronous listener
 * on purpose: the repository raises the event with `emitAsync` and awaits it,
 * so the card is closed by the time the terminal write resolves.
 */
@Injectable()
export class AgentRunTerminalEscalationListener {
    constructor(@Optional() private readonly escalations?: AgentEscalationService) {}

    @OnEvent(AGENT_RUN_TERMINAL_EVENT, { suppressErrors: true })
    async handleRunTerminal(event: AgentRunTerminalEvent): Promise<void> {
        if (!this.escalations) return;
        if (event?.attentionReason !== ATTENTION_REASON_QUEUED_TOO_LONG) return;
        await this.escalations.closeQueuedTooLongForEndedRun({
            runId: event.runId,
            status: event.status,
            finishedAt: event.finishedAt,
        });
    }
}
