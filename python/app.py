from flask import Flask, request, jsonify
import cv2
import numpy as np
from deepface import DeepFace
import os

app = Flask(__name__)

# --- CONFIG ---
# Ensure you have your reference image in the python-service folder
REFERENCE_IMG_PATH = "owner.jpg" 
MODEL_NAME = "Facenet"
CONFIDENCE_THRESHOLD = 0.40

# --- LOAD MODEL AT STARTUP ---
print("⏳ Loading AI Model... (Wait for 'Ready')")
# Perform a dummy verify to load weights into memory
try:
    DeepFace.build_model(MODEL_NAME)
    print("✅ AI Model Ready!")
except Exception as e:
    print(f"❌ Model Error: {e}")

@app.route('/verify', methods=['POST'])
def verify_face():
    if 'image' not in request.files:
        return jsonify({"verified": False, "message": "No image sent"}), 400

    try:
        # 1. Read the image sent by Node.js
        file = request.files['image']
        npimg = np.frombuffer(file.read(), np.uint8)
        frame = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        # 2. Verify
        result = DeepFace.verify(
            img1_path=frame,
            img2_path=REFERENCE_IMG_PATH,
            model_name=MODEL_NAME,
            distance_metric="cosine",
            enforce_detection=False
        )

        # 3. Check Result
        if result['verified'] and result['distance'] < CONFIDENCE_THRESHOLD:
            return jsonify({
                "verified": True, 
                "message": "Face Verified Successfully",
                "distance": result['distance']
            })
        else:
            return jsonify({
                "verified": False, 
                "message": "Face Mismatch: Access Denied"
            })

    except Exception as e:
        print("Error:", str(e))
        return jsonify({"verified": False, "message": "AI Processing Error"}), 500

if __name__ == '__main__':
    # Run on Port 5002
    app.run(host='0.0.0.0', port=5002, debug=False)