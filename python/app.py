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

# 🔴 DEBUG MODE
DEBUG_MODE = True

def debug_print(tag, message):
    if DEBUG_MODE:
        print(f"🐍 [PY-DEBUG] {tag}: {message}")

# Settings
MODEL_NAME = "ArcFace" 
DETECTOR_BACKEND = "ssd" 
TARGET_WIDTH = 320  # Keeping your requested 320px limit

# Load Model
try:
    print("⏳ Loading AI Models...")
    DeepFace.build_model(MODEL_NAME)
    print(f"✅ {MODEL_NAME} Model Ready!")
except Exception as e:
    print(f"❌ Model Error: {e}")

def analyze_lighting(frame):
    """
    Returns a status string if lighting is bad, or None if lighting is okay.
    """
    # Convert to grayscale to check brightness intensity
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    avg_brightness = np.mean(gray)

    debug_print("Light-Check", f"Average Brightness: {avg_brightness:.2f}")

    if avg_brightness < 50:
        return "Lighting Issue: Environment is too dark. Please ensure better lighting."
    if avg_brightness > 200:
        return "Lighting Issue: Too much glare or brightness. Please avoid direct light."
    
    return None # Lighting is acceptable

@app.route('/generate-embedding', methods=['POST'])
def generate_embedding():
    if 'image' not in request.files:
        return jsonify({"status": False, "message": "No image sent"}), 400

    try:
        file = request.files['image']
        npimg = np.frombuffer(file.read(), np.uint8)
        frame = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        if frame is None:
            raise ValueError("Could not decode image")

        # 🚀 OPTIMIZATION: Resize to 320px as per your request
        height, width = frame.shape[:2]
        if width > TARGET_WIDTH:
            scale_factor = TARGET_WIDTH / width
            new_height = int(height * scale_factor)
            frame = cv2.resize(frame, (TARGET_WIDTH, new_height), interpolation=cv2.INTER_AREA)
            debug_print("Img-Resized", f"Resized to {TARGET_WIDTH}px width")

        # Attempt to Generate Embedding
        embedding_objs = DeepFace.represent(
            img_path=frame,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=True, # Must be True for Registration
            align=True
        )
        
        embedding = embedding_objs[0]["embedding"]
        return jsonify({
            "status": True, 
            "embedding": embedding, 
            "message": "Success"
        })

    except ValueError as ve:
        # ⚠️ DeepFace failed to find a face. Now we investigate WHY.
        error_str = str(ve)
        
        if "Face could not be detected" in error_str:
            # 1. Check Lighting First
            lighting_msg = analyze_lighting(frame)
            if lighting_msg:
                return jsonify({"status": False, "message": lighting_msg}), 400
            
            # 2. If Lighting is OK, it must be Angle, Distance, or Obstruction
            return jsonify({
                "status": False, 
                "message": "Angle/Position Issue: Face not visible. Please look directly at camera and remove masks/glasses."
            }), 400

        return jsonify({"status": False, "message": f"AI Error: {error_str}"}), 500

    except Exception as e:
        return jsonify({"status": False, "message": f"Server Error: {str(e)}"}), 500

if __name__ == '__main__':
    from waitress import serve
    print(f"🚀 Serving on port 8000 (Size Limit: {TARGET_WIDTH}px)...")
    serve(app, host='0.0.0.0', port=8000, threads=1)