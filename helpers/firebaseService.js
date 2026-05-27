const admin = require("firebase-admin");
const path = require("path");

// Initialize Firebase Admin
// You need to download your service account key from Firebase Console
// Project Settings -> Service accounts -> Generate new private key
let firebaseInitialized = false;

try {
    const serviceAccount = require("../config/firebase-service-account.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Firebase Admin SDK initialization failed. Push notifications will be disabled.");
    console.error("Error:", error.message);
    console.log("Make sure you have config/firebase-service-account.json file.");
}

/**
 * Send push notification to a single device
 * @param {string} token - FCM registration token
 * @param {object} payload - Notification payload { title, body, data }
 */
const sendPushNotification = async (token, payload) => {
    if (!firebaseInitialized || !token) return null;

    const message = {
        notification: {
            title: payload.title,
            body: payload.body,
        },
        data: payload.data || {},
        token: token,
        // Webpush config for browser notifications
        webpush: {
            notification: {
                title: payload.title,
                body: payload.body,
                icon: "/images/logo02.png", // Custom Airwix Logo
                badge: "/images/fevicon.png", // Status bar badge
                click_action: payload.redirect_url || "/",
            }
        },
        // Android config
        android: {
            notification: {
                click_action: "FLUTTER_NOTIFICATION_CLICK",
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log("Successfully sent FCM message:", response);
        return response;
    } catch (error) {
        console.error("Error sending FCM message:", error);
        throw error;
    }
};

/**
 * Send push notification to multiple devices
 * @param {Array<string>} tokens - Array of FCM registration tokens
 * @param {object} payload - Notification payload
 */
const sendMulticastNotification = async (tokens, payload) => {
    if (!firebaseInitialized || !tokens || tokens.length === 0) return null;

    const message = {
        notification: {
            title: payload.title,
            body: payload.body,
        },
        data: payload.data || {},
        tokens: tokens,
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`${response.successCount} messages were sent successfully`);
        return response;
    } catch (error) {
        console.error("Error sending multicast FCM message:", error);
        return null;
    }
};

module.exports = {
    sendPushNotification,
    sendMulticastNotification,
    firebaseInitialized
};
