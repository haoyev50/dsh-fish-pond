#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
桌面鱼塘 —— 无边框、置顶、可拖动，脱离 DSH 独立存在
=============================================================================
2026-10-24 重构：不再播放「烘焙好的卡片图」，而是自己画鲸鱼 + 实时排文字。
所以字号改了立刻生效，也不需要任何图片文件。

透明：Tk 在 Windows 上只支持颜色键控，把 alpha 二值化后把背景涂成洋红再抠掉。

布局：窗口比鲸鱼宽，鲸鱼靠右，对话框在左——**不挡鲸鱼**，超出鲸鱼那格也没关系。

交互：左键拖动，右键菜单（说精选 / 说评论 / 悬浮于 DSH / 关闭）。
=============================================================================
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import tkinter as tk
from tkinter import font as tkfont
from PIL import Image, ImageTk

KEY_RGB = (255, 0, 255)
KEY_HEX = '#ff00ff'
FPS_MS = 83
SWAP_SECONDS = 7
LINE_SECONDS = 18
NAVY = '#1a2440'


def key_frame(im, size):
    """RGBA → 抠好了的 RGB（透明处填洋红，半透明二值化避免洋红边）。"""
    im = im.convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    alpha = im.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
    im.putalpha(alpha)
    bg = Image.new('RGB', im.size, KEY_RGB)
    bg.paste(im, (0, 0), im)
    return bg


def load_frames(path, size, step=2):
    frames = []
    try:
        im = Image.open(path)
    except Exception as exc:            # noqa: BLE001
        print(f'[pond] 读不了 {path}: {exc}', file=sys.stderr)
        return frames
    total = getattr(im, 'n_frames', 1)
    for i in range(0, total, step):
        try:
            im.seek(i)
            frames.append(key_frame(im, size))
        except EOFError:
            break
    return frames


def http_json(url, payload=None, timeout=3):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'content-type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode('utf-8'))


class PondWindow:
    def __init__(self, api, assets, size, margin=24):
        self.api = api.rstrip('/')
        self.assets = assets
        self.size = size
        self.margin = margin

        # 气泡要比鲸鱼宽得多，否则长标题会被窗口边缘裁掉
        self.win_w = int(size * 2.6)
        self.win_h = size

        self.frames = {}
        self.photos = {}
        self.cursor = None
        self.queue = []
        self.line = None            # (item, until_ts)
        self.loop = 'idle'
        self.loop_started = 0
        self.pool = []              # 今天所有台词，空闲时自己轮着说
        self.pool_at = 0
        self.turn = 0
        self.last_end = 0

        self.root = tk.Tk()
        self.root.title('大肥鱼塘')
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        try:
            self.root.attributes('-transparentcolor', KEY_HEX)
        except tk.TclError:
            pass

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f'{self.win_w}x{self.win_h}+{sw - self.win_w - margin}+{sh - self.win_h - margin - 60}')

        self.canvas = tk.Canvas(self.root, width=self.win_w, height=self.win_h,
                                bg=KEY_HEX, highlightthickness=0, bd=0)
        self.canvas.pack(fill='both', expand=True)

        self.font_px = 15
        self.text_font = tkfont.Font(family='Microsoft YaHei UI', size=int(self.font_px))

        # 气泡：先建好，默认隐藏
        self.rect = self.canvas.create_rectangle(0, 0, 0, 0, fill='#ffffff', outline=NAVY, width=2, state='hidden')
        self.txt = self.canvas.create_text(0, 0, anchor='nw', text='', fill=NAVY,
                                           font=self.text_font, width=int(self.win_w - size - 30), state='hidden')
        self.txt2 = self.canvas.create_text(0, 0, anchor='nw', text='', fill=NAVY,
                                            font=self.text_font, state='hidden')
        self.txt3 = self.canvas.create_text(0, 0, anchor='nw', text='', fill='#e53935',
                                            font=self.text_font, state='hidden')

        self.image_item = self.canvas.create_image(self.win_w, self.win_h, anchor='se')

        self.canvas.bind('<Button-1>', self.on_press)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<Button-3>', self.on_menu)
        self.root.bind('<Escape>', lambda _e: self.quit())

        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label='说精选', command=lambda: self.replay('digest'))
        self.menu.add_command(label='说评论', command=lambda: self.replay('comment'))
        self.menu.add_separator()
        self.menu.add_command(label='悬浮于 DSH', command=self.dock)
        self.menu.add_command(label='关闭', command=self.quit)

        self.load_clip('idle')
        self.load_clip('swim')
        self.load_settings()

        self.loop_started = self.now()
        self.tick()
        self.poll()

    # ---------- 基础 ----------

    def now(self):
        return time.time()

    def load_settings(self):
        try:
            d = http_json(f'{self.api}/api/deep-fish-pond/settings')
            if isinstance(d.get('bubbleFontPx'), int):
                self.font_px = d['bubbleFontPx']
                self.text_font.configure(size=int(self.font_px))
        except Exception:          # noqa: BLE001 - 读不到就用默认
            pass

    def load_clip(self, name):
        path = os.path.join(self.assets, name + '.webp')
        self.frames[name] = load_frames(path, self.size)

    def photo(self, name, idx):
        key = (name, idx)
        cached = self.photos.get(key)
        if cached is None:
            frames = self.frames.get(name) or []
            if not frames:
                return None
            cached = ImageTk.PhotoImage(frames[idx % len(frames)])
            self.photos[key] = cached
        return cached

    # ---------- 拖动 / 菜单 ----------

    def on_press(self, event):
        self._drag = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def on_drag(self, event):
        if not getattr(self, '_drag', None):
            return
        dx, dy = self._drag
        self.root.geometry(f'+{event.x_root - dx}+{event.y_root - dy}')

    def on_menu(self, event):
        try:
            self.menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.menu.grab_release()

    # ---------- 台词 ----------

    def show_line(self, item):
        """item: {'kind','title','tag','text'} —— 精选用「标题 / 挡位」，挡位标红。"""
        self.line = (item, self.now() + LINE_SECONDS)
        # 每句都从用户设的字号开始，装不下再由 fit_font 往回收
        self.text_font.configure(size=int(self.font_px))
        is_digest = item.get('kind') == 'digest' and item.get('title')
        if is_digest:
            self.canvas.itemconfigure(self.txt, state='normal', text='标题：' + item['title'])
            self.canvas.itemconfigure(self.txt2, state='normal', text='挡位：')
            self.canvas.itemconfigure(self.txt3, state='normal' if item.get('tag') else 'hidden', text=item.get('tag', ''))
        else:
            self.canvas.itemconfigure(self.txt, state='normal', text=item.get('text', ''))
            self.canvas.itemconfigure(self.txt2, state='hidden')
            self.canvas.itemconfigure(self.txt3, state='hidden')
        self.canvas.itemconfigure(self.rect, state='normal')
        self.fit_font()

    def hide_line(self):
        self.line = None
        for it in (self.txt, self.txt2, self.txt3, self.rect):
            self.canvas.itemconfigure(it, state='hidden')
        self.loop_started = self.now()
        self.last_end = self.now()

    def layout_bubble(self):
        """按文字实际大小摆放气泡：放左边，绝不压住右边的鲸鱼。"""
        if not self.line:
            return
        item = self.line[0]
        pad = 10
        left = 12
        x = left + pad
        y = 8 + pad
        self.canvas.coords(self.txt, x, y)
        b1 = self.canvas.bbox(self.txt)
        if not b1:
            return
        bottom = b1[3]
        right = b1[2]

        if self.canvas.itemcget(self.txt2, 'state') != 'hidden':
            y2 = bottom + 4
            self.canvas.coords(self.txt2, x, y2)
            b2 = self.canvas.bbox(self.txt2)
            self.canvas.coords(self.txt3, b2[2], y2)
            b3 = self.canvas.bbox(self.txt3)
            if b3:
                bottom = max(bottom, b3[3])
                right = max(right, b3[2])

        right = min(right + pad, self.win_w - 6)
        self.canvas.coords(self.rect, left, max(4, b1[1] - pad), right, bottom + pad)
        self.canvas.tag_lower(self.rect)

    def fit_font(self):
        """字太大就把字号往回收，保证「标题 + 挡位」两行都在窗口里。"""
        limit = self.win_h - 24
        size = int(self.font_px)
        has_tag = self.canvas.itemcget(self.txt3, 'state') != 'hidden'
        while size > 9:
            self.text_font.configure(size=size)
            # ⚠️ 必须先让 Tk 重排，否则 bbox 不随字号变化，会一路缩到最小
            self.root.update_idletasks()
            bbox = self.canvas.bbox(self.txt)
            h = (bbox[3] - bbox[1]) if bbox else 0
            if has_tag:
                h += size + 14        # 挡位那一行 + 间距
            if h <= limit:
                break
            size -= 1

    # ---------- 播放 ----------

    def tick(self):
        try:
            if self.line is not None:
                if self.now() >= self.line[1]:
                    self.hide_line()
                else:
                    self.layout_bubble()
                    self.root.after(FPS_MS, self.tick)
                    return

            if self.now() - self.loop_started >= SWAP_SECONDS:
                self.loop = 'swim' if self.loop == 'idle' else 'idle'
                self.loop_started = self.now()

            frames = self.frames.get(self.loop) or []
            if frames:
                idx = int((self.now() - self.loop_started) * (1000 / FPS_MS)) % len(frames)
                ph = self.photo(self.loop, idx)
                if ph is not None:
                    self._img = ph
                    self.canvas.itemconfigure(self.image_item, image=ph)
        except tk.TclError:
            return
        self.root.after(FPS_MS, self.tick)

    # ---------- 轮询 ----------

    def poll(self):
        try:
            if self.line is None and self.queue:
                self.show_line(self.queue.pop(0))

            # 台词池 + 空闲自说：没人点菜单、也没有新台词时，隔 45 秒自己挑一句
            now = self.now()
            if now - self.pool_at > 300:
                self.pool_at = now
                try:
                    d = http_json(f'{self.api}/api/deep-fish-pond/cards?kind=digest&limit=50')
                    self.pool = [c for c in (d.get('cards') or []) if c.get('text')]
                except Exception:      # noqa: BLE001
                    pass
            if self.line is None and not self.queue and self.pool and now - (self.last_end or 0) > 45:
                self.turn = (self.turn + 1) % len(self.pool)
                self.show_line(self.pool[self.turn])

            url = f'{self.api}/api/deep-fish-pond/status' + ('' if self.cursor is None else f'?since={self.cursor}')
            data = http_json(url)
            seq = data.get('seq')
            if isinstance(seq, int):
                if self.cursor is None:
                    self.cursor = seq
                elif data.get('cards'):
                    self.cursor = seq
                    for c in data['cards']:
                        if c.get('text'):
                            self.queue.append(c)
        except Exception:          # noqa: BLE001 - 宿主没起来就先只显示鲸鱼
            pass
        self.root.after(3000, self.poll)

    def replay(self, kind):
        try:
            data = http_json(f'{self.api}/api/deep-fish-pond/cards?kind={kind}&limit=20')
            cards = [c for c in (data.get('cards') or []) if c.get('text')]
            if cards:
                self.queue = cards
                self.hide_line()
                self.show_line(self.queue.pop(0))
        except Exception as exc:   # noqa: BLE001
            print(f'[pond] 取台词失败: {exc}', file=sys.stderr)

    # ---------- 收尾 ----------

    def quit(self):
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def dock(self):
        try:
            http_json(f'{self.api}/api/deep-fish-pond/float?action=stop', payload={})
        except Exception:          # noqa: BLE001
            pass
        self.quit()

    def run(self):
        self.root.mainloop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--api', required=True)
    ap.add_argument('--assets', required=True)
    ap.add_argument('--size', type=int, default=220)
    ap.add_argument('--margin', type=int, default=24)
    args = ap.parse_args()

    pond = PondWindow(args.api, args.assets, args.size, args.margin)
    pond.run()


if __name__ == '__main__':
    main()
