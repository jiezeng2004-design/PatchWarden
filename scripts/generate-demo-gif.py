from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "patchwarden-oss-demo.gif"

W, H = 1280, 720
BG = (246, 248, 245)
INK = (32, 39, 39)
MUTED = (91, 101, 101)
GREEN = (38, 124, 92)
TEAL = (25, 112, 116)
BLUE = (48, 92, 160)
ORANGE = (183, 104, 36)
RED = (165, 62, 62)
LINE = (205, 214, 208)
PANEL = (255, 255, 252)
SHADOW = (218, 224, 219)
TERMINAL = (27, 34, 34)
TERMINAL_TEXT = (208, 230, 218)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


F_TITLE = font(44, True)
F_H2 = font(27, True)
F_BODY = font(22)
F_SMALL = font(18)
F_MONO = font(19)
F_MONO_SMALL = font(16)


def rounded(draw: ImageDraw.ImageDraw, box, fill, outline=None, radius=18, width=2):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0 + 6, y0 + 8, x1 + 6, y1 + 8), radius, fill=SHADOW)
    draw.rounded_rectangle(box, radius, fill=fill, outline=outline or LINE, width=width)


def label(draw: ImageDraw.ImageDraw, xy, text, fill=INK, fnt=F_BODY, anchor=None):
    draw.text(xy, text, fill=fill, font=fnt, anchor=anchor)


def pill(draw: ImageDraw.ImageDraw, xy, text, fill, text_fill=(255, 255, 255)):
    x, y = xy
    bbox = draw.textbbox((0, 0), text, font=F_SMALL)
    pad_x = 14
    pad_y = 7
    w = bbox[2] - bbox[0] + pad_x * 2
    h = bbox[3] - bbox[1] + pad_y * 2
    draw.rounded_rectangle((x, y, x + w, y + h), h // 2, fill=fill)
    draw.text((x + pad_x, y + pad_y - 1), text, fill=text_fill, font=F_SMALL)


def wrap(draw: ImageDraw.ImageDraw, text: str, width: int, fnt=F_BODY) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        test = f"{current} {word}".strip()
        if draw.textlength(test, font=fnt) <= width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_panel_text(draw, box, title, body, accent):
    x0, y0, x1, y1 = box
    rounded(draw, box, PANEL, LINE)
    draw.rectangle((x0, y0, x0 + 8, y1), fill=accent)
    label(draw, (x0 + 28, y0 + 24), title, fnt=F_H2)
    y = y0 + 68
    for line in wrap(draw, body, x1 - x0 - 56, F_BODY):
        label(draw, (x0 + 28, y), line, fill=MUTED, fnt=F_BODY)
        y += 30


def draw_terminal(draw, box, lines):
    rounded(draw, box, TERMINAL, (66, 78, 78), radius=16)
    x0, y0, x1, _ = box
    draw.ellipse((x0 + 20, y0 + 18, x0 + 32, y0 + 30), fill=(236, 98, 86))
    draw.ellipse((x0 + 42, y0 + 18, x0 + 54, y0 + 30), fill=(241, 190, 76))
    draw.ellipse((x0 + 64, y0 + 18, x0 + 76, y0 + 30), fill=(99, 198, 103))
    y = y0 + 54
    for line, color in lines:
        label(draw, (x0 + 24, y), line, fill=color, fnt=F_MONO_SMALL)
        y += 25
        if y > box[3] - 24:
            break


def draw_progress(draw, active: int):
    steps = [
        ("Plan", BLUE),
        ("Guard", TEAL),
        ("Execute", ORANGE),
        ("Evidence", GREEN),
        ("Review", GREEN),
    ]
    start_x = 165
    y = 650
    gap = 235
    for i, (name, color) in enumerate(steps):
        x = start_x + gap * i
        if i > 0:
            line_color = color if i <= active else LINE
            draw.line((x - gap + 48, y, x - 48, y), fill=line_color, width=5)
        fill = color if i <= active else (226, 232, 228)
        text = (255, 255, 255) if i <= active else MUTED
        draw.ellipse((x - 28, y - 28, x + 28, y + 28), fill=fill)
        label(draw, (x, y - 1), str(i + 1), fill=text, fnt=F_H2, anchor="mm")
        label(draw, (x, y + 44), name, fill=INK if i <= active else MUTED, fnt=F_SMALL, anchor="mm")


def base(title: str, subtitle: str, active: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    label(draw, (64, 42), title, fnt=F_TITLE)
    label(draw, (66, 96), subtitle, fill=MUTED, fnt=F_BODY)
    pill(draw, (1040, 48), "privacy-safe demo", GREEN)
    draw_progress(draw, active)
    return img, draw


def frame_intro():
    img, draw = base(
        "PatchWarden OSS Demo",
        "A safe MCP task loop for ChatGPT, Codex, OpenCode, and local maintainers.",
        0,
    )
    draw_panel_text(
        draw,
        (90, 170, 1190, 530),
        "What this GIF shows",
        "A model plans work, PatchWarden turns it into a bounded task, a registered local agent executes it, and the maintainer reviews redacted evidence before accepting anything.",
        GREEN,
    )
    pill(draw, (130, 420), "no API keys", BLUE)
    pill(draw, (280, 420), "no real account names", TEAL)
    pill(draw, (520, 420), "no unrestricted shell", ORANGE)
    pill(draw, (770, 420), "no auto-publish", RED)
    return img


def frame_plan():
    img, draw = base(
        "1. Model creates a bounded plan",
        "The upstream client asks for a small maintainer task, not a raw shell command.",
        0,
    )
    draw_panel_text(
        draw,
        (70, 160, 590, 520),
        "ChatGPT / Codex",
        "Goal: update docs for a small OSS workflow. Verify with npm.cmd test. Return summary, diff, and evidence only.",
        BLUE,
    )
    draw_panel_text(
        draw,
        (690, 160, 1210, 520),
        "PatchWarden MCP",
        "Receives structured task input with repo_path, agent, template, and allowlisted verification commands.",
        TEAL,
    )
    draw.line((600, 340, 680, 340), fill=BLUE, width=6)
    draw.polygon([(680, 340), (660, 328), (660, 352)], fill=BLUE)
    return img


def frame_guard():
    img, draw = base(
        "2. PatchWarden checks the safety boundary",
        "Local policy decides what can run and where files may change.",
        1,
    )
    draw_panel_text(
        draw,
        (70, 160, 1210, 330),
        "Guardrails",
        "repo_path must stay under workspaceRoot. Agent launch commands come from trusted config. Verification commands must exactly match allowedTestCommands.",
        TEAL,
    )
    draw_panel_text(
        draw,
        (70, 380, 580, 540),
        "Blocked by default",
        ".env, tokens, SSH keys, cookies, credential files, out-of-workspace writes, and arbitrary shell.",
        RED,
    )
    draw_panel_text(
        draw,
        (700, 380, 1210, 540),
        "Allowed",
        "A pre-registered local agent can work on the requested repository and produce auditable evidence.",
        GREEN,
    )
    return img


def frame_execute():
    img, draw = base(
        "3. Watcher launches the registered agent",
        "The task is executed locally while PatchWarden records status and scope evidence.",
        2,
    )
    draw_terminal(
        draw,
        (80, 160, 1200, 540),
        [
            ("> patchwarden watcher", TERMINAL_TEXT),
            ("queued task_20260709_demo", (156, 205, 255)),
            ("repo_path: demo-oss-project", TERMINAL_TEXT),
            ("agent: opencode (registered)", TERMINAL_TEXT),
            ("verify: npm.cmd test (allowlisted)", TERMINAL_TEXT),
            ("scope: inside workspaceRoot", (142, 222, 170)),
            ("status: running -> done", (142, 222, 170)),
        ],
    )
    return img


def frame_evidence():
    img, draw = base(
        "4. Evidence is written for review",
        "The maintainer can inspect safe summaries before opening deeper logs or diffs.",
        3,
    )
    draw_panel_text(
        draw,
        (80, 150, 410, 540),
        "result.json",
        "status, warnings, changed-file groups, and recommended next actions.",
        GREEN,
    )
    draw_panel_text(
        draw,
        (475, 150, 805, 540),
        "diff.patch",
        "Git diff evidence when available, kept separate from the model plan.",
        BLUE,
    )
    draw_panel_text(
        draw,
        (870, 150, 1200, 540),
        "verify.json",
        "Exact commands, exit codes, and verification status.",
        ORANGE,
    )
    return img


def frame_review():
    img, draw = base(
        "5. Maintainer accepts, fixes, or rejects",
        "PatchWarden supports review. It does not silently push, publish, or restart services.",
        4,
    )
    draw_panel_text(
        draw,
        (80, 160, 1200, 520),
        "OSS maintainer handoff",
        "Use safe_result, safe_audit, safe_test_summary, and evidence packs to decide the next step. Release actions still require separate human confirmation and GitHub/npm verification.",
        GREEN,
    )
    pill(draw, (165, 410), "reviewable", GREEN)
    pill(draw, (360, 410), "redacted", TEAL)
    pill(draw, (525, 410), "bounded", BLUE)
    pill(draw, (680, 410), "confirmation-gated", ORANGE)
    return img


def hold(frames, image, count):
    for _ in range(count):
        frames.append(image.copy())


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    scenes = [
        frame_intro(),
        frame_plan(),
        frame_guard(),
        frame_execute(),
        frame_evidence(),
        frame_review(),
    ]
    frames: list[Image.Image] = []
    for scene in scenes:
        hold(frames, scene, 12)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=120,
        loop=0,
        optimize=True,
    )
    print(OUT)


if __name__ == "__main__":
    main()
