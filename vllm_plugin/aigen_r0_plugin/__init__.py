def register():
    from vllm import ModelRegistry

    if "AigenR0ForConditionalGeneration" not in ModelRegistry.get_supported_archs():
        ModelRegistry.register_model(
            "AigenR0ForConditionalGeneration",
            "aigen_r0_plugin.model:AigenR0ForConditionalGeneration",
        )
