import json
import sys

from PIL import Image, ImageGrab
import numpy as np

if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')

reader = None


def get_reader():
    global reader
    if reader is None:
        import easyocr
        reader = easyocr.Reader(['ch_sim', 'en'], gpu=False, verbose=False)
    return reader


def recognize(image, payload, origin=None):
    origin = origin or {}
    x = int(origin.get('x', 0))
    y = int(origin.get('y', 0))
    scale = float(origin.get('scale') or 1.0)
    query = payload.get('query') or {}
    limit = max(1, min(int(query.get('limit') or 10), 50))
    elements = []
    for box, text, confidence in get_reader().readtext(np.array(image)):
        left = min(point[0] for point in box)
        top = min(point[1] for point in box)
        right = max(point[0] for point in box)
        bottom = max(point[1] for point in box)
        elements.append({
            'name': text,
            'role': 'text',
            'confidence': round(float(confidence), 4),
            'bounds': {
                'x': x + round(left * scale), 'y': y + round(top * scale),
                'width': round((right - left) * scale), 'height': round((bottom - top) * scale)
            }
        })
    elements.sort(key=lambda item: item['confidence'], reverse=True)
    return {'elements': elements[:limit]}

def capture(payload):
    bounds = payload.get('bounds') or {}
    x = int(bounds.get('x', 0))
    y = int(bounds.get('y', 0))
    width = int(bounds.get('width', 0))
    height = int(bounds.get('height', 0))
    if width <= 0 or height <= 0:
        raise ValueError('invalid_capture_bounds')
    image = ImageGrab.grab(bbox=(x, y, x + width, y + height), all_screens=True)
    return recognize(image, payload, bounds)


for line in sys.stdin:
    try:
        payload = json.loads(line)
        if payload.get('op') == 'health':
            response = {'ok': True, 'loaded': reader is not None}
        elif payload.get('op') == 'capture':
            response = capture(payload)
        elif payload.get('op') == 'image':
            response = recognize(Image.open(payload['path']).convert('RGB'), payload, payload.get('origin'))
        else:
            response = {'error': 'unknown_operation'}
    except Exception as error:
        response = {'error': str(error)}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
    sys.stdout.flush()
