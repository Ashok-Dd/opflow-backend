import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';

import { JwtService } from '../../common/auth/jwt.service';
import { LiveBus, LiveChange } from '../../infra/bus/live-bus';
import { DbService } from '../../infra/db/db.service';
import { doctorLine, LiveService, patientBoard } from './live.service';

interface SocketData {
  userId: string;
  role: 'patient' | 'doctor';
  doctorId?: string;
  exp: number;
  /** sessionId → the patient's booking in it */
  bookings: Map<string, string>;
  doctorSessions: Set<string>;
}

/**
 * WebSocket namespace /live. The phone connects with its access token, then `join {sessionId}`.
 * Patients receive `board` (their own place only); the doctor receives `line` (the full list).
 * When the token is about to expire the server sends `reauth`; the phone answers `auth {token}`.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: true } })
export class LiveGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveGateway.name);
  @WebSocketServer() server!: Namespace;
  private off?: () => void;

  constructor(
    private readonly jwt: JwtService,
    private readonly live: LiveService,
    private readonly dbs: DbService,
    private readonly bus: LiveBus,
  ) {}

  onModuleInit(): void {
    this.off = this.bus.onChange((c) => void this.push(c).catch((err: Error) => this.log.warn(`Live push failed: ${err.message}`)));
  }

  onModuleDestroy(): void {
    this.off?.();
  }

  private authenticate(socket: Socket, token: unknown): boolean {
    try {
      const c = this.jwt.verify(String(token ?? ''), 'app');
      const prev = socket.data as Partial<SocketData>;
      socket.data = {
        userId: c.sub,
        role: c.role as 'patient' | 'doctor',
        doctorId: c.did,
        exp: c.exp,
        bookings: prev.bookings ?? new Map(),
        doctorSessions: prev.doctorSessions ?? new Set(),
      } satisfies SocketData;
      const ms = c.exp * 1000 - Date.now() - 60_000;
      setTimeout(() => socket.connected && socket.emit('reauth'), Math.max(1000, ms)).unref();
      return true;
    } catch {
      return false;
    }
  }

  handleConnection(socket: Socket): void {
    const auth = socket.handshake.auth as { token?: string } | undefined;
    if (!this.authenticate(socket, auth?.token ?? socket.handshake.headers.authorization?.replace(/^Bearer /, ''))) {
      socket.emit('error_message', { code: 'UNAUTHENTICATED', message: 'Please log in again.' });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('auth')
  reauth(@ConnectedSocket() socket: Socket, @MessageBody() body: { token?: string }) {
    if (!this.authenticate(socket, body?.token)) {
      socket.emit('error_message', { code: 'UNAUTHENTICATED', message: 'Please log in again.' });
      socket.disconnect(true);
    }
    return { ok: true };
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { sessionId?: string }) {
    const d = socket.data as SocketData;
    const sessionId = String(body?.sessionId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(sessionId) || d.exp * 1000 < Date.now()) return { ok: false, code: 'NOT_ALLOWED' };
    try {
      if (d.role === 'doctor') {
        const view = await this.live.doctorView(d.doctorId!, sessionId);
        d.doctorSessions.add(sessionId);
        await socket.join(`session:${sessionId}`);
        socket.emit('line', view);
      } else {
        const b = await this.dbs.as({ role: 'patient', userId: d.userId }, (tx) =>
          tx.selectFrom('bookings').select('id').where('sessionId', '=', sessionId).where('patientUserId', '=', d.userId).where('status', 'in', ['confirmed', 'completed', 'no_show']).executeTakeFirst(),
        );
        if (!b) return { ok: false, code: 'NOT_ALLOWED' };
        d.bookings.set(sessionId, b.id);
        await socket.join(`session:${sessionId}`);
        socket.emit('board', await this.live.patientView(d.userId, sessionId));
      }
      return { ok: true };
    } catch {
      return { ok: false, code: 'NOT_ALLOWED' };
    }
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { sessionId?: string }) {
    const d = socket.data as SocketData;
    const sessionId = String(body?.sessionId ?? '');
    d.bookings.delete(sessionId);
    d.doctorSessions.delete(sessionId);
    await socket.leave(`session:${sessionId}`);
    return { ok: true };
  }

  /** One database read per change, then each socket gets its own view. */
  private async push(change: LiveChange): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(`session:${change.sessionId}`).fetchSockets();
    if (sockets.length === 0) return;
    const { head, entries } = await this.live.load(undefined, change.sessionId);
    const line = doctorLine(head, entries);
    for (const s of sockets) {
      const d = s.data as SocketData;
      if (d.role === 'doctor' && d.doctorId === head.doctorId) s.emit('line', line);
      else {
        const bookingId = d.bookings?.get(change.sessionId);
        if (bookingId) s.emit('board', patientBoard(head, entries, bookingId));
      }
    }
  }
}
