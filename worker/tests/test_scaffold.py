def test_worker_package_is_importable():
    import worker

    assert worker.__doc__
