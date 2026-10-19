"""Assemble a single page (inline CSS and JS) for publishing; data files stay alongside in data/."""
import re
from pathlib import Path
web = Path(__file__).parents[1] / "web"
html = (web / "index.html").read_text()
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
body = body.replace('<script type="module" src="src/app.js"></script>', "")
out = (
    '<title>Forest Change Explorer</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
    f"<style>\n{(web / 'src/styles.css').read_text()}\n</style>\n{body}\n"
    f'<script type="module">\n{(web / "src/app.js").read_text()}\n</script>\n'
)
dist = Path(__file__).parents[1] / "dist"
dist.mkdir(exist_ok=True)
(dist / "forest-change.html").write_text(out)
print("wrote", dist / "forest-change.html", len(out))
