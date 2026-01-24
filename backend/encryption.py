# ============================================
# FILENAME: backend/encryption.py
# ============================================

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
import os
import base64

# Get encryption key from environment
ENCRYPTION_KEY_RAW = os.getenv("ENCRYPTION_KEY", "kanairy-secret-key-32-characters-long!")

# Ensure key is at least 32 characters
if len(ENCRYPTION_KEY_RAW) < 32:
    ENCRYPTION_KEY_RAW = ENCRYPTION_KEY_RAW.ljust(32, "0")[:32]

# Derive a proper 32-byte key using PBKDF2
def get_encryption_key():
    kdf = PBKDF2(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b'kanairy_salt_2024',  # Static salt for key derivation
        iterations=100000,
        backend=default_backend()
    )
    return kdf.derive(ENCRYPTION_KEY_RAW.encode())

ENCRYPTION_KEY = get_encryption_key()

def encrypt_password(password: str) -> dict:
    """Encrypt password using AES-256-GCM"""
    try:
        # Generate random IV (initialization vector)
        iv = os.urandom(16)
        
        # Create cipher
        cipher = Cipher(
            algorithms.AES(ENCRYPTION_KEY),
            modes.GCM(iv),
            backend=default_backend()
        )
        encryptor = cipher.encryptor()
        
        # Encrypt
        ciphertext = encryptor.update(password.encode()) + encryptor.finalize()
        
        return {
            'encrypted': base64.b64encode(ciphertext).decode('utf-8'),
            'iv': base64.b64encode(iv).decode('utf-8'),
            'auth_tag': base64.b64encode(encryptor.tag).decode('utf-8')
        }
    except Exception as e:
        print(f"❌ Encryption error: {e}")
        raise

def decrypt_password(encrypted: str, iv: str, auth_tag: str) -> str:
    """Decrypt password using AES-256-GCM"""
    try:
        # Decode from base64
        ciphertext = base64.b64decode(encrypted)
        iv_bytes = base64.b64decode(iv)
        tag = base64.b64decode(auth_tag)
        
        # Create cipher
        cipher = Cipher(
            algorithms.AES(ENCRYPTION_KEY),
            modes.GCM(iv_bytes, tag),
            backend=default_backend()
        )
        decryptor = cipher.decryptor()
        
        # Decrypt
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
        
        return plaintext.decode('utf-8')
    except Exception as e:
        print(f"❌ Decryption error: {e}")
        raise

print("🔐 Encryption module loaded")