import { describe, it, expect } from 'vitest';

import {
  isTurnAware,
  type ChannelAdapter,
  type ChannelMessage,
  type ChannelStartContext,
} from '../../../v6/channels/contracts.js';

/**
 * 契约测试 —— 这个文件盯的是**形状**,不是实现。
 * 另一支团队按同一份 contracts.ts 写 MeshChannel;这里跑绿 = 他们照抄能插进来。
 */

class FakeChannel implements ChannelAdapter {
  readonly name = 'fake';
  descriptor = { sourceLabel: '[fake]' };
  sent: Array<{ endpointId: string; text: string; mediaFiles?: string[] }> = [];
  started = false;
  stopped = false;
  private deliver?: (msg: ChannelMessage) => void;

  async start(ctx: ChannelStartContext): Promise<void> {
    this.started = true;
    this.deliver = ctx.deliver;
  }

  async send(endpointId: string, reply: { text: string; mediaFiles?: string[] }): Promise<void> {
    this.sent.push({ endpointId, ...reply });
  }

  health(): { ok: boolean; detail?: string; lastOkAt?: number } {
    return { ok: this.started && !this.stopped };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  emit(msg: ChannelMessage): void {
    this.deliver?.(msg);
  }
}

function sampleMessage(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'm-1',
    channel: 'fake',
    endpointId: 'peer-1',
    text: 'hello',
    mediaPaths: [],
    receivedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('ChannelAdapter 契约', () => {
  it('五个方法 + descriptor 都在,签名对得上', async () => {
    const ch = new FakeChannel();
    expect(typeof ch.name).toBe('string');
    expect(typeof ch.start).toBe('function');
    expect(typeof ch.send).toBe('function');
    expect(typeof ch.health).toBe('function');
    expect(typeof ch.stop).toBe('function');
    expect(typeof ch.descriptor.sourceLabel).toBe('string');

    await expect(ch.start({ deliver: () => {} })).resolves.toBeUndefined();
    await expect(ch.send('peer-1', { text: 'hi' })).resolves.toBeUndefined();
    await expect(ch.stop()).resolves.toBeUndefined();
  });

  it('start(ctx) 拿到的 deliver 是 Core 的入口,壳只管往里丢 ChannelMessage', async () => {
    const ch = new FakeChannel();
    const got: ChannelMessage[] = [];
    await ch.start({ deliver: (m) => got.push(m) });
    ch.emit(sampleMessage({ text: 'yo' }));

    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      id: 'm-1',
      channel: 'fake',
      endpointId: 'peer-1',
      text: 'yo',
      mediaPaths: [],
      receivedAt: 1_700_000_000_000,
    });
  });

  it('ChannelMessage 里没有 conversationId —— 会话主权归 Core,壳不许自己定', () => {
    const msg = sampleMessage();
    expect(Object.keys(msg).sort()).toEqual(
      ['channel', 'endpointId', 'id', 'mediaPaths', 'receivedAt', 'text'].sort(),
    );
    expect('conversationId' in msg).toBe(false);
  });

  it('threadKey 可选:不给也是合法消息', () => {
    const withThread = sampleMessage({ threadKey: 't-1' });
    expect(withThread.threadKey).toBe('t-1');
    expect(sampleMessage().threadKey).toBeUndefined();
  });

  it('health() 是同步的,ok 必填,detail/lastOkAt 可选', () => {
    const ch = new FakeChannel();
    const h = ch.health();
    expect(typeof h.ok).toBe('boolean');
    expect(h).not.toBeInstanceOf(Promise);
  });

  it('sourceLabel 由壳自报,Core 不认识「微信」这两个字', () => {
    expect(new FakeChannel().descriptor.sourceLabel).toBe('[fake]');
  });
});

describe('可选扩展 —— turn 生命周期(纯 additive,鸭子类型)', () => {
  it('没实现 beginTurn 的壳照样是合法 ChannelAdapter', () => {
    expect(isTurnAware(new FakeChannel())).toBe(false);
  });

  it('实现了就被认出来,Core 拿到的是「这轮结束」回调', () => {
    const calls: string[] = [];
    const turnAware = Object.assign(new FakeChannel(), {
      beginTurn(msg: ChannelMessage) {
        calls.push(`begin:${msg.id}`);
        return () => calls.push(`end:${msg.id}`);
      },
    });

    expect(isTurnAware(turnAware)).toBe(true);
    const end = turnAware.beginTurn(sampleMessage());
    end();
    expect(calls).toEqual(['begin:m-1', 'end:m-1']);
  });

  it('isTurnAware 对乱七八糟的东西不误判', () => {
    expect(isTurnAware(null)).toBe(false);
    expect(isTurnAware(undefined)).toBe(false);
    expect(isTurnAware({})).toBe(false);
    expect(isTurnAware({ beginTurn: 'not a function' })).toBe(false);
  });
});
