# save as check_braces.py and run: python check_braces.py muralizer.html
import sys
pairs = {'{':'}','(':')','[':']'}
opens = set(pairs.keys())
closes = {v:k for k,v in pairs.items()}
def report(msg, line, col, ch):
    print(f"{msg} at line {line}, col {col}: '{ch}'")
    sys.exit(0)
def scan(path):
    stack = []
    with open(path, 'r', encoding='utf8') as f:
        for lineno, line in enumerate(f, start=1):
            for col, ch in enumerate(line, start=1):
                if ch in opens:
                    stack.append((ch, lineno, col))
                elif ch in closes:
                    if not stack:
                        report("Unmatched closing", lineno, col, ch)
                    last, lno, lcol = stack.pop()
                    if closes[ch] != last:
                        print(f"Mismatch: opened '{last}' at {lno}:{lcol} but closed by '{ch}' at {lineno}:{col}")
                        sys.exit(0)
    if stack:
        last, lno, lcol = stack[-1]
        print(f"Unclosed opening '{last}' starting at line {lno}, col {lcol}")
    else:
        print("All braces/paren/brackets balanced.")
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python check_braces.py muralizer.html")
    else:
        scan(sys.argv[1])
