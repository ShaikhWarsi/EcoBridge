import 'dart:async';
import 'dart:typed_data';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

class WebcamScreen extends StatefulWidget {
  final io.Socket socket;
  const WebcamScreen({super.key, required this.socket});

  @override
  State<WebcamScreen> createState() => _WebcamScreenState();
}

class _WebcamScreenState extends State<WebcamScreen> {
  CameraController? _controller;
  bool _isStreaming = false;
  Timer? _frameTimer;

  @override
  void initState() {
    super.initState();
    _initializeCamera();
  }

  Future<void> _initializeCamera() async {
    final cameras = await availableCameras();
    if (cameras.isEmpty) return;

    _controller = CameraController(
      cameras[0],
      ResolutionPreset.medium,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );

    try {
      await _controller!.initialize();
      if (mounted) setState(() {});
    } catch (e) {
      debugPrint("Camera initialization error: $e");
    }
  }

  void _toggleStreaming() {
    setState(() {
      _isStreaming = !_isStreaming;
    });

    if (_isStreaming) {
      _startStreaming();
    } else {
      _stopStreaming();
    }
  }

  void _startStreaming() {
    // We'll use takePicture in a loop for the simplest JPEG stream implementation
    // For a real low-latency pipeline, we'd use startImageStream with native encoding
    _frameTimer = Timer.periodic(const Duration(milliseconds: 100), (timer) async {
      if (!_isStreaming || _controller == null || !_controller!.value.isInitialized) return;

      try {
        final XFile file = await _controller!.takePicture();
        final Uint8List bytes = await file.readAsBytes();
        widget.socket.emit('video-frame', bytes);
      } catch (e) {
        debugPrint("Error capturing frame: $e");
      }
    });
  }

  void _stopStreaming() {
    _frameTimer?.cancel();
    _frameTimer = null;
  }

  @override
  void dispose() {
    _stopStreaming();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_controller == null || !_controller!.value.isInitialized) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator(color: Colors.white)),
      );
    }

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text("Virtual Webcam", style: TextStyle(color: Colors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: Center(
              child: AspectRatio(
                aspectRatio: _controller!.value.aspectRatio,
                child: CameraPreview(_controller!),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(24.0),
            child: ElevatedButton(
              onPressed: _toggleStreaming,
              style: ElevatedButton.styleFrom(
                backgroundColor: _isStreaming ? Colors.red : Colors.white,
                foregroundColor: _isStreaming ? Colors.white : Colors.black,
                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              ),
              child: Text(_isStreaming ? "Stop Streaming" : "Start Streaming"),
            ),
          ),
        ],
      ),
    );
  }
}
