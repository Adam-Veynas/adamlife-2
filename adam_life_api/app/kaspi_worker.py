"""Bounded subprocess: PDF bytes on stdin, structured result only on stdout."""
import json
import logging
import sys

from app.kaspi_pdf import MAX_BYTES, StatementError, parse_pdf

if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    if sys.platform != 'win32':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    try:
        output = {'statement': parse_pdf(sys.stdin.buffer.read(MAX_BYTES + 1))}
    except StatementError as error:
        output = {'error': str(error)}
    except Exception:
        output = {'error': 'PDF повреждён или его структура не поддерживается.'}
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode('utf-8'))
