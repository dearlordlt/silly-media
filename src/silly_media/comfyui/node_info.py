"""Minimal ComfyUI node definitions for /object_info compatibility."""

NODE_INFO: dict = {
    "CheckpointLoaderSimple": {
        "input": {
            "required": {
                "ckpt_name": [["z-image-turbo.safetensors"]],
            }
        },
        "input_order": {"required": ["ckpt_name"]},
        "output": ["MODEL", "CLIP", "VAE"],
        "output_is_list": [False, False, False],
        "output_name": ["MODEL", "CLIP", "VAE"],
        "name": "CheckpointLoaderSimple",
        "display_name": "Load Checkpoint",
        "category": "loaders",
        "output_node": False,
    },
    "KSampler": {
        "input": {
            "required": {
                "model": ["MODEL"],
                "seed": ["INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}],
                "steps": ["INT", {"default": 9, "min": 1, "max": 100}],
                "cfg": ["FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.1}],
                "sampler_name": [
                    [
                        "euler",
                        "euler_ancestral",
                        "heun",
                        "dpm_2",
                        "dpm_2_ancestral",
                        "lms",
                        "dpm_fast",
                        "dpm_adaptive",
                        "dpmpp_2s_ancestral",
                        "dpmpp_sde",
                        "dpmpp_2m",
                        "ddim",
                        "uni_pc",
                    ]
                ],
                "scheduler": [["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform"]],
                "positive": ["CONDITIONING"],
                "negative": ["CONDITIONING"],
                "latent_image": ["LATENT"],
                "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}],
            }
        },
        "input_order": {
            "required": [
                "model",
                "seed",
                "steps",
                "cfg",
                "sampler_name",
                "scheduler",
                "positive",
                "negative",
                "latent_image",
                "denoise",
            ]
        },
        "output": ["LATENT"],
        "output_is_list": [False],
        "output_name": ["LATENT"],
        "name": "KSampler",
        "display_name": "KSampler",
        "category": "sampling",
        "output_node": False,
    },
    "CLIPTextEncode": {
        "input": {
            "required": {
                "text": ["STRING", {"multiline": True, "dynamicPrompts": True}],
                "clip": ["CLIP"],
            }
        },
        "input_order": {"required": ["text", "clip"]},
        "output": ["CONDITIONING"],
        "output_is_list": [False],
        "output_name": ["CONDITIONING"],
        "name": "CLIPTextEncode",
        "display_name": "CLIP Text Encode (Prompt)",
        "category": "conditioning",
        "output_node": False,
    },
    "EmptyLatentImage": {
        "input": {
            "required": {
                "width": ["INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}],
                "height": ["INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}],
                "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}],
            }
        },
        "input_order": {"required": ["width", "height", "batch_size"]},
        "output": ["LATENT"],
        "output_is_list": [False],
        "output_name": ["LATENT"],
        "name": "EmptyLatentImage",
        "display_name": "Empty Latent Image",
        "category": "latent",
        "output_node": False,
    },
    "VAEDecode": {
        "input": {
            "required": {
                "samples": ["LATENT"],
                "vae": ["VAE"],
            }
        },
        "input_order": {"required": ["samples", "vae"]},
        "output": ["IMAGE"],
        "output_is_list": [False],
        "output_name": ["IMAGE"],
        "name": "VAEDecode",
        "display_name": "VAE Decode",
        "category": "latent",
        "output_node": False,
    },
    "SaveImage": {
        "input": {
            "required": {
                "images": ["IMAGE"],
                "filename_prefix": ["STRING", {"default": "ComfyUI"}],
            }
        },
        "input_order": {"required": ["images", "filename_prefix"]},
        "output": [],
        "output_is_list": [],
        "output_name": [],
        "name": "SaveImage",
        "display_name": "Save Image",
        "category": "image",
        "output_node": True,
    },
    "PreviewImage": {
        "input": {
            "required": {
                "images": ["IMAGE"],
            }
        },
        "input_order": {"required": ["images"]},
        "output": [],
        "output_is_list": [],
        "output_name": [],
        "name": "PreviewImage",
        "display_name": "Preview Image",
        "category": "image",
        "output_node": True,
    },
}
