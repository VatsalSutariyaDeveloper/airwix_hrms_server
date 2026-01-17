# from flask import Flask, request, jsonify
# import cv2
# import numpy as np
# from deepface import DeepFace

# app = Flask(__name__)

# # 1. Use ArcFace (Best for Accuracy)
# MODEL_NAME = "ArcFace" 

# # 2. Use 'ssd' or 'mtcnn' (Much faster than RetinaFace, but still accurate)
# # If 'ssd' is still too slow, try 'opencv' (fastest, but struggles in dark)
# DETECTOR_BACKEND = "ssd" 

# # Preload model
# try:
#     print("⏳ Loading AI Models...")
#     DeepFace.build_model(MODEL_NAME)
#     print(f"✅ {MODEL_NAME} Model Ready!")
# except Exception as e:
#     print(f"❌ Model Error: {e}")

# @app.route('/generate-embedding', methods=['POST'])
# def generate_embedding():
#     if 'image' not in request.files:
#         return jsonify({"status": False, "message": "No image sent"}), 400

#     try:
#         file = request.files['image']
#         npimg = np.frombuffer(file.read(), np.uint8)
#         frame = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

#         # 🚀 OPTIMIZATION: Resize heavy images to speed up detection
#         # If image is wider than 640px, resize it. 
#         # DeepFace aligns it to 112x112 anyway, so 4K inputs are wasted processing.
#         height, width = frame.shape[:2]
#         if width > 640:
#             scale_factor = 640 / width
#             new_height = int(height * scale_factor)
#             frame = cv2.resize(frame, (640, new_height), interpolation=cv2.INTER_AREA)

#         # Generate Embedding
#         embedding_objs = DeepFace.represent(
#             img_path=frame,
#             model_name=MODEL_NAME,
#             detector_backend=DETECTOR_BACKEND,
#             enforce_detection=True,
#             align=True
#         )

#         embedding = embedding_objs[0]["embedding"]

#         return jsonify({
#             "status": True,
#             "embedding": embedding,
#             "message": "Embedding generated"
#         })

#     except Exception as e:
#         if "Face could not be detected" in str(e):
#             return jsonify({"status": False, "message": "Face not found. Please look at the camera."}), 400
#         return jsonify({"status": False, "message": f"Error: {str(e)}"}), 500

# if __name__ == '__main__':
#     # Threaded=True helps handle multiple requests faster
#     app.run(host='0.0.0.0', port=8000, threaded=True)

from flask import Flask, request, jsonify
import cv2
import numpy as np
from deepface import DeepFace

app = Flask(__name__)

# 🔴 TOGGLE DEBUG MODE
DEBUG_MODE = True

def debug_print(tag, message):
    if DEBUG_MODE:
        print(f"🐍 [PY-DEBUG] {tag}: {message}")

# 1. Use ArcFace (Best for Accuracy)
MODEL_NAME = "ArcFace" 
DETECTOR_BACKEND = "ssd" 

try:
    print("⏳ Loading AI Models...")
    DeepFace.build_model(MODEL_NAME)
    print(f"✅ {MODEL_NAME} Model Ready!")
except Exception as e:
    print(f"❌ Model Error: {e}")

@app.route('/generate-embedding', methods=['POST'])
def generate_embedding():
    if 'image' not in request.files:
        return jsonify({"status": False, "message": "No image sent"}), 400

    try:
        file = request.files['image']
        debug_print("Input", f"File received: {file.filename}")

        npimg = np.frombuffer(file.read(), np.uint8)
        frame = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        if frame is None:
            raise ValueError("Could not decode image")

        height, width = frame.shape[:2]
        debug_print("Img-Original", f"W: {width} x H: {height}")

        # 🚀 OPTIMIZATION: Resize
        target_width = 320 
        
        if width > target_width:
            scale_factor = target_width / width
            new_height = int(height * scale_factor)
            frame = cv2.resize(frame, (target_width, new_height), interpolation=cv2.INTER_AREA)
            debug_print("Img-Resized", f"W: {target_width} x H: {new_height}")

        # Generate Embedding
        debug_print("AI", "Starting DeepFace representation...")
        embedding_objs = DeepFace.represent(
            img_path=frame,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=True,
            align=True
        )
        
        embedding = embedding_objs[0]["embedding"]
        debug_print("AI", f"Vector Generated. Length: {len(embedding)}")
        
        # Sanity check: ensure it's not empty
        if len(embedding) == 0:
            raise ValueError("Generated embedding is empty")

        return jsonify({
            "status": True,
            "embedding": embedding,
            "message": "Embedding generated"
        })

    except Exception as e:
        error_msg = str(e)
        debug_print("ERROR", error_msg)
        
        if "Face could not be detected" in error_msg:
            return jsonify({"status": False, "message": "Face not found. Please look at the camera."}), 400
        
        return jsonify({"status": False, "message": f"Error: {error_msg}"}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, threaded=False)